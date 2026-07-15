/**
 * S3-compatible storage service for invoice file uploads and presigned URLs.
 * Handles MIME validation, size enforcement, tenant scoping, and path traversal prevention.
 *
 * Exposes a cheap {@link probeS3Connectivity} operation that uses the S3
 * `HeadBucket` API to verify that the configured bucket is reachable and
 * that the credentials authorize reads against it. The probe is consumed by
 * the readiness health check and the startup probe so misconfigured object
 * storage is surfaced before user traffic depends on it.
 *
 * @module services/storage
 */

'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');
const db = require('../db/knex');
const logger = require('../logger');

/** Approximate budget for the S3 health probe, in milliseconds. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * AWS S3 error classes whose names are safe to surface to operators without
 * leaking credentials or endpoint details. Anything outside this allowlist is
 * collapsed into the generic `unknown` code by {@link sanitizeStorageError}.
 *
 * Names actionable for a `HeadBucket` call only â€” names like `NoSuchKey` are
 * omitted because they cannot originate from a bucket-level probe.
 *
 * @type {ReadonlySet<string>}
 */
const SAFE_ERROR_NAMES = new Set([
  'NoSuchBucket',
  'AccessDenied',
  'InvalidAccessKeyId',
  'InvalidBucketName',
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
  'NetworkingError',
  'TimeoutError',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'PermanentRedirect',
  'TemporaryRedirect',
  'KMSAccessDenied',
  'KMSDisabled',
]);

/** Accepted MIME types for invoice uploads. */
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];

/** Default maximum file size (512 KB). */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;

/** Presigned upload URL expiry (15 minutes). */
const DEFAULT_UPLOAD_URL_EXPIRY_SEC = 900;

/** Presigned download URL expiry (1 hour). */
const DEFAULT_DOWNLOAD_URL_EXPIRY_SEC = 3600;

/** Maximum allowed presigned URL expiry (24 hours). */
const MAX_DOWNLOAD_URL_EXPIRY_SEC = 86400;

function parseSize(sizeStr) {
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return DEFAULT_MAX_FILE_SIZE;
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
}

const MAX_FILE_SIZE = parseSize(process.env.BODY_LIMIT_INVOICE || '512kb');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET || 'liquifact-invoices';
    this.maxFileSize = MAX_FILE_SIZE;
    this._inMemoryStore = new Map();
  }

  _sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      const err = new Error('Invalid filename');
      err.code = 'INVALID_FILENAME';
      throw err;
    }

    const normalized = path.posix.normalize(filename);

    if (normalized.includes('..') || normalized.startsWith('/') || normalized.startsWith('\\')) {
      const err = new Error('Path traversal detected');
      err.code = 'INVALID_FILENAME';
      throw err;
    }

    let name = path.basename(normalized);
    name = name.replace(/\0/g, '');
    name = name.replace(/[<>:\"|?*\\/]/g, '_');
    return name.slice(0, 255);
  }

  _validateMimeType(mimeType) {
    return ALLOWED_MIME_TYPES.includes(mimeType);
  }

  _validateTenantId(tenantId) {
    return typeof tenantId === 'string' && /^[a-zA-Z0-9_-]+$/.test(tenantId);
  }

  _validateInvoiceId(invoiceId) {
    return typeof invoiceId === 'string' && /^[a-zA-Z0-9_-]+$/.test(invoiceId);
  }

  _generateKey(tenantId, invoiceId, safeName) {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }
    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }

    const uuid = crypto.randomUUID();
    return `tenants/${tenantId}/invoices/${invoiceId}/${uuid}-${safeName}`;
  }

  async uploadFile(fileBuffer, fileName, mimeType, tenantId = 'unknown', invoiceId = 'unknown') {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }

    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }

    if (fileBuffer.length > this.maxFileSize) {
      const err = new Error(`File size ${fileBuffer.length} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    });
    await s3Client.send(command);
    return key;
  }

  async getPresignedUploadUrl({ tenantId, invoiceId, fileName, mimeType, fileSize }) {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }
    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }
    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }
    if (fileSize > this.maxFileSize) {
      const err = new Error(`File size ${fileSize} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: fileSize,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: DEFAULT_UPLOAD_URL_EXPIRY_SEC });
    return { url, key };
  }

  async getSignedUrl(key, expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SEC) {
    const expiry = Math.floor(expiresIn);
    if (expiry < 1 || expiry > MAX_DOWNLOAD_URL_EXPIRY_SEC) {
      const err = new Error(`Expiry must be between 1 and ${MAX_DOWNLOAD_URL_EXPIRY_SEC} seconds`);
      err.code = 'INVALID_EXPIRY';
      throw err;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn: expiry });
  }

  async saveMetadata({ tenantId, invoiceId, key, sha256, mimeType, size }) {
    const now = new Date().toISOString();
    await db('invoice_files').insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      s3_key: key,
      sha256,
      mime_type: mimeType,
      size,
      created_at: now,
    });
  }

  async getMetadata({ tenantId, invoiceId }) {
    return await db('invoice_files').where({ tenant_id: tenantId, invoice_id: invoiceId }).first();
  }

  async validateUploadedObject(key, declaredMime, declaredSize) {
    if (process.env.NODE_ENV === 'test') {
      const entry = this._inMemoryStore.get(key);
      if (!entry) { const err = new Error('Uploaded object not found'); err.code = 'UPLOAD_NOT_FOUND'; throw err; }
      const valid = entry.mimeType === declaredMime && entry.body.length === declaredSize;
      return { valid, contentType: entry.mimeType, contentLength: entry.body.length };
    }
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const cmd = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    const res = await s3Client.send(cmd);
    const ct = res.ContentType || '';
    const cl = res.ContentLength || 0;
    if (cl > this.maxFileSize) { const err = new Error(`Uploaded file size ${cl} exceeds maximum`); err.code = 'FILE_TOO_LARGE'; throw err; }
    if (declaredMime === 'application/pdf' && cl > 0) {
      try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const gCmd = new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-4' });
        const gRes = await s3Client.send(gCmd);
        const chunks = []; for await (const c of gRes.Body) { chunks.push(c); }
        if (Buffer.concat(chunks).toString('utf8') !== '%PDF-') { const err = new Error('Invalid PDF header'); err.code = 'INVALID_PDF_HEADER'; throw err; }
      } catch (e) { if (e.code === 'INVALID_PDF_HEADER') throw e; }
    }
    return { valid: ct === declaredMime && cl === declaredSize, contentType: ct, contentLength: cl };
  }

  async validateUploadedObject(key, declaredMime, declaredSize) {
    if (process.env.NODE_ENV === 'test') {
      const entry = this._inMemoryStore.get(key);
      if (!entry) { const err = new Error('Uploaded object not found'); err.code = 'UPLOAD_NOT_FOUND'; throw err; }
      const valid = entry.mimeType === declaredMime && entry.body.length === declaredSize;
      return { valid, contentType: entry.mimeType, contentLength: entry.body.length };
    }
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const cmd = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    const res = await s3Client.send(cmd);
    const ct = res.ContentType || '';
    const cl = res.ContentLength || 0;
    if (cl > this.maxFileSize) { const err = new Error(`Uploaded file size ${cl} exceeds maximum`); err.code = 'FILE_TOO_LARGE'; throw err; }
    if (declaredMime === 'application/pdf' && cl > 0) {
      try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const gCmd = new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-4' });
        const gRes = await s3Client.send(gCmd);
        const chunks = []; for await (const c of gRes.Body) { chunks.push(c); }
        if (Buffer.concat(chunks).toString('utf8') !== '%PDF-') { const err = new Error('Invalid PDF header'); err.code = 'INVALID_PDF_HEADER'; throw err; }
      } catch (e) { if (e.code === 'INVALID_PDF_HEADER') throw e; }
    }
    return { valid: ct === declaredMime && cl === declaredSize, contentType: ct, contentLength: cl };
  }

  generateKey({ tenantId, invoiceId, fileName }) {
    const safeName = this._sanitizeFilename(fileName);
    return this._generateKey(tenantId, invoiceId, safeName);
  }

  async uploadFileInMemory({ key, body, mimeType }) {
    if (process.env.NODE_ENV === 'test') {
      this._inMemoryStore.set(key, { body, mimeType });
      return;
    }
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType });
    await s3Client.send(command);
  }

  async getFile({ key }) {
    if (process.env.NODE_ENV === 'test') {
      const entry = this._inMemoryStore.get(key);
      if (!entry) { throw new Error('File not found'); }
      return entry.body;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const response = await s3Client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

/**
 * Returns the S3 bucket name the service is configured to use. Empty string
 * when no bucket has been configured.
 *
 * @returns {string} The configured bucket name, or empty string when absent.
 */
function getConfiguredBucket() {
  return process.env.S3_BUCKET || '';
}

/**
 * Determines whether in-memory fallback storage is in effect. Used to skip
 * the connectivity probe in environments that intentionally do not talk to
 * S3 (e.g. unit-test runs against the {@link StorageService} API).
 *
 * @returns {boolean} `true` when in-memory fallback is active.
 */
function isInMemoryFallbackActive() {
  if (process.env.STORAGE_IN_MEMORY === 'true') {
    return true;
  }
  if (process.env.STORAGE_IN_MEMORY === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'test';
}

/**
 * Determines whether the S3 connectivity probe is explicitly disabled by
 * configuration. Operators can opt-out via `S3_HEALTHCHECK_ENABLED=false`
 * (e.g. to silence the probe in offline dev sandboxes). Any value other
 * than the literal string `'false'` keeps the probe enabled.
 *
 * @returns {boolean} `true` when the probe is disabled by configuration.
 */
function isProbeExplicitlyDisabled() {
  return process.env.S3_HEALTHCHECK_ENABLED === 'false';
}

/**
 * Determines whether credentials are configured for the S3 client. The
 * probe will not run without at least an access key id, since the AWS SDK
 * would otherwise emit debug logs containing unsigned request details.
 *
 * @returns {boolean} `true` when AWS credentials are configured.
 */
function hasCredentialsConfigured() {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Sanitizes an AWS SDK error into a redacted summary safe to surface in
 * health endpoints and log output. **Never** includes the original
 * `err.message`, `$metadata.requestId`, endpoint URL, or any header map that
 * may have contained a signed `Authorization` header.
 *
 * Only the AWS error name (allow-listed in {@link SAFE_ERROR_NAMES}) and a
 * fixed short hint are returned.
 *
 * @param {unknown} err - The error thrown by the S3 client.
 * @returns {{code: string, hint: string}} Redacted error descriptor.
 */
function sanitizeStorageError(err) {
  const name = err && typeof err === 'object' && typeof err.name === 'string'
    ? err.name
    : 'UnknownError';

  if (SAFE_ERROR_NAMES.has(name)) {
    return { code: name, hint: STORAGE_ERROR_HINTS[name] || 'object storage unavailable' };
  }
  return { code: 'UnknownError', hint: 'object storage unreachable' };
}

/** Mapping of allowed AWS error names to short, actionable hints. */
const STORAGE_ERROR_HINTS = Object.freeze({
  NoSuchBucket: 'configured bucket not found',
  AccessDenied: 'credentials lack permission to access bucket',
  InvalidAccessKeyId: 'AWS access key id rejected by object storage',
  NetworkingError: 'network error contacting object storage',
  TimeoutError: 'object storage probe timed out',
});

/**
 * Cheap connectivity probe for the configured S3 bucket. Issues a
 * `HeadBucket` request via the shared {@link s3Client} and classifies the
 * outcome.
 *
 * Result states:
 *
 * - `'healthy'` â€” `HeadBucket` returned 200. Bucket exists and creds work.
 * - `'in_memory'` â€” In-memory fallback is active (`NODE_ENV === 'test'` or
 *   `STORAGE_IN_MEMORY === 'true'`); the probe is a no-op.
 * - `'disabled'` â€” Operator disabled the probe via
 *   `S3_HEALTHCHECK_ENABLED=false`.
 * - `'not_configured'` â€” Either `S3_BUCKET` or `AWS_ACCESS_KEY_ID` is
 *   absent; the probe cannot run.
 * - `'unhealthy'` â€” `HeadBucket` failed. `error.code` is an AWS error name,
 *   `error.hint` is a short actionable message.
 *
 * Credentials, endpoint URLs, and other sensitive error fields are
 * intentionally stripped from the returned object.
 *
 * @param {Object} [options] - Optional overrides.
 * @param {typeof s3Client} [options.client] - S3 client to use (tests).
 * @param {number} [options.timeoutMs] - Probe timeout in milliseconds.
 * @returns {Promise<{
 *   status: 'healthy'|'in_memory'|'disabled'|'not_configured'|'unhealthy',
 *   latency?: number,
 *   bucketConfigured?: boolean,
 *   credentialsConfigured?: boolean,
 *   error?: {code: string, hint: string}
 * }>} Probe result.
 */
async function probeS3Connectivity(options = {}) {
  if (isProbeExplicitlyDisabled()) {
    return { status: 'disabled', bucketConfigured: Boolean(getConfiguredBucket()), credentialsConfigured: hasCredentialsConfigured() };
  }

  if (isInMemoryFallbackActive()) {
    return { status: 'in_memory', bucketConfigured: Boolean(getConfiguredBucket()), credentialsConfigured: hasCredentialsConfigured() };
  }

  if (!getConfiguredBucket() || !hasCredentialsConfigured()) {
    return { status: 'not_configured', bucketConfigured: Boolean(getConfiguredBucket()), credentialsConfigured: hasCredentialsConfigured() };
  }

  const client = options.client || s3Client;
  const envTimeoutMs = parseInt(process.env.STORAGE_HEALTHCHECK_TIMEOUT_MS, 10);
  const defaultTimeoutMs = Number.isInteger(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : PROBE_TIMEOUT_MS;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs;
  const start = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Probe timeout');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') { timer.unref(); }
  });

  try {
    const sendPromise = client.send(new HeadBucketCommand({ Bucket: getConfiguredBucket() }));
    // Swallow any rejection on the loser's side so we don't trigger an
    // unhandled-rejection warning if the timeout fires before the SDK's
    // own retry/timeout chain finishes.
    sendPromise.catch(() => {});
    await Promise.race([sendPromise, timeoutPromise]);
    return { status: 'healthy', latency: Date.now() - start, bucketConfigured: true, credentialsConfigured: true };
  } catch (rawErr) {
    const sanitized = sanitizeStorageError(rawErr);
    logger.error(
      {
        component: 's3-healthcheck',
        event: 'probe_failed',
        errorCode: sanitized.code,
        latencyMs: Date.now() - start,
        bucketConfigured: true,
        credentialsConfigured: true,
      },
      `S3 connectivity probe failed: ${sanitized.hint} (${sanitized.code})`
    );
    return {
      status: 'unhealthy',
      latency: Date.now() - start,
      error: sanitized,
      bucketConfigured: true,
      credentialsConfigured: true,
    };
  } finally {
    if (timer) { clearTimeout(timer); }
  }
}

/**
 * Runs the S3 connectivity probe once at process start. Failures are logged
 * with a clear, actionable error but never propagated to caller code â€”
 * startup should still proceed (the readiness probe surfaces storage
 * misconfiguration to orchestrators once the HTTP server is listening).
 *
 * The probe function can be overridden via the optional argument so tests
 * can substitute a deterministic fake without mocking the entire module.
 *
 * @param {Function} [probeFn] - Optional probe replacement (defaults to
 *   {@link probeS3Connectivity}).
 * @returns {Promise<{status: string}>} The probe result status.
 */
async function runStartupStorageProbe(probeFn = probeS3Connectivity) {
  const result = await probeFn();
  if (result.status === 'healthy') {
    logger.info(
      { component: 's3-healthcheck', event: 'startup_probe', status: result.status, latencyMs: result.latency },
      'S3 connectivity probe succeeded'
    );
  } else if (result.status === 'unhealthy') {
    logger.warn(
      {
        component: 's3-healthcheck',
        event: 'startup_probe',
        status: result.status,
        errorCode: result.error && result.error.code,
      },
      `S3 connectivity probe failed at startup: ${result.error ? result.error.hint : 'unknown'}`
    );
  } else {
    logger.info(
      { component: 's3-healthcheck', event: 'startup_probe', status: result.status },
      `S3 connectivity probe skipped at startup: ${result.status}`
    );
  }
  return result;
}

module.exports.StorageService = StorageService;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.DEFAULT_MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;
module.exports.probeS3Connectivity = probeS3Connectivity;
module.exports.runStartupStorageProbe = runStartupStorageProbe;
module.exports.sanitizeStorageError = sanitizeStorageError;
module.exports.getConfiguredBucket = getConfiguredBucket;
module.exports.isInMemoryFallbackActive = isInMemoryFallbackActive;
module.exports.isProbeExplicitlyDisabled = isProbeExplicitlyDisabled;
module.exports.hasCredentialsConfigured = hasCredentialsConfigured;
module.exports.SAFE_ERROR_NAMES = SAFE_ERROR_NAMES;
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
module.exports.logger = logger;


