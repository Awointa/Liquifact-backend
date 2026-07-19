/**
 * KYC Service
 * Manages KYC verification workflows and status persistence.
 *
 * Supports optional external KYC provider integration when env keys are present.
 * Falls back cleanly to an in-memory mock implementation for local/test use.
 *
 * @module services/kycService
 */
 
const db = require('../db/knex');
const logger = require('../logger');
const { MemoryCacheStore } = require('./cacheStore');
 
const KYC_STATUSES = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
  UNKNOWN: 'unknown', // Fallback for unmapped provider statuses
};
 
const PROVIDER_STATUS_MAP = {
  pending: KYC_STATUSES.PENDING,
  in_review: KYC_STATUSES.PENDING,
  reviewing: KYC_STATUSES.PENDING,
  queued: KYC_STATUSES.PENDING,
  submitted: KYC_STATUSES.PENDING,
  verified: KYC_STATUSES.VERIFIED,
  approved: KYC_STATUSES.VERIFIED,
  pass: KYC_STATUSES.VERIFIED,
  success: KYC_STATUSES.VERIFIED,
  rejected: KYC_STATUSES.REJECTED,
  denied: KYC_STATUSES.REJECTED,
  declined: KYC_STATUSES.REJECTED,
  failed: KYC_STATUSES.REJECTED,
  exempted: KYC_STATUSES.EXEMPTED,
  exempt: KYC_STATUSES.EXEMPTED,
  waived: KYC_STATUSES.EXEMPTED,
};
 
// In-memory store for KYC records (used in test/dev environments)
const mockKycRecords = new Map();

/**
 * Short-TTL cache for external KYC provider status lookups (issue #440).
 * Backed by MemoryCacheStore so eviction / invalidation is consistent across
 * all cache users in the process.
 *
 * @type {MemoryCacheStore}
 */
const kycStatusCache = new MemoryCacheStore({ maxEntries: 2000 });

/**
 * Key prefix used to namespace external KYC status cache entries.
 * Keeps KYC cache keys from colliding with other cache users.
 *
 * @constant {string}
 */
const STATUS_CACHE_KEY_PREFIX = 'kyc:ext:';

/**
 * Default TTL (in seconds) for the external KYC status cache.
 * 30 s strikes a balance between freshness and avoiding provider rate limits.
 *
 * @constant {number}
 */
const DEFAULT_STATUS_CACHE_TTL_SECONDS = 30;
 
/**
 * Configuration for external KYC provider.
 * Loaded from environment variables.
 *
 * @returns {{enabled: boolean, apiKey: (string|null), baseUrl: (string|null), apiSecret: (string|null)}}
 */
const getKycProviderConfig = () => {
  return {
    enabled: !!(process.env.KYC_PROVIDER_API_KEY && process.env.KYC_PROVIDER_URL),
    apiKey: process.env.KYC_PROVIDER_API_KEY || null,
    baseUrl: process.env.KYC_PROVIDER_URL || null,
    apiSecret: process.env.KYC_PROVIDER_SECRET || null, // optional secondary key used for webhook HMAC verification
  };
};
 
/**
 * Resolves the configured TTL (in milliseconds) for the external KYC status
 * cache from `KYC_STATUS_CACHE_TTL_SECONDS`.
 *
 * A non-positive, non-numeric, or zero value disables caching entirely (the
 * provider is consulted on every read). This makes it possible to switch the
 * cache off in environments that require strict freshness without code changes.
 *
 * @returns {number} TTL in milliseconds, or 0 when caching is disabled.
 */
function getStatusCacheTtlMs() {
  const raw = process.env.KYC_STATUS_CACHE_TTL_SECONDS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_STATUS_CACHE_TTL_SECONDS * 1000;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.floor(seconds * 1000);
}

/**
 * Builds the cache key for an SME's external KYC status entry.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {string} The namespaced cache key.
 */
function statusCacheKey(smeId) {
  return `${STATUS_CACHE_KEY_PREFIX}${smeId}`;
}

/**
 * Invalidates the cached external KYC status for an SME.
 *
 * Called on every persisted status write (verification, rejection, exemption,
 * provider refresh, and KYC webhook ingestion) so that a cached approval can
 * never outlive a subsequent revocation or status change event.
 *
 * @param {string} smeId - The SME identifier whose cache entry to drop.
 * @returns {void}
 */
function invalidateKycStatusCache(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    return;
  }
  kycStatusCache.del(statusCacheKey(smeId));
}

/**
 * Reads an SME's external KYC status through a short-TTL cache.
 *
 * On a cache hit (within TTL) the cached status object is returned and the
 * `loader` — which performs the external provider call — is **not** invoked,
 * avoiding redundant provider traffic and rate-limit pressure. On a miss (or
 * when caching is disabled via TTL) the `loader` is awaited and its result is
 * cached for the configured TTL.
 *
 * Security: the cache is never a source of stale "approved" data past an event.
 * The `loader` ({@link verifyWithExternalProvider}) persists the fresh status,
 * which invalidates this key via {@link invalidateKycStatusCache} before the
 * new value is stored, and any later webhook/manual write invalidates it again.
 *
 * @param {string} smeId - The SME identifier (used as the cache key).
 * @param {function(): Promise<{status: string, recordId: (string|null), verifiedAt: (string|null)}>} loader
 *   Async loader that fetches the authoritative status from the provider.
 * @returns {Promise<{status: string, recordId: (string|null), verifiedAt: (string|null)}>}
 *   The cached or freshly-loaded KYC status object.
 */
async function readProviderStatusCached(smeId, loader) {
  const ttlMs = getStatusCacheTtlMs();
  if (ttlMs <= 0) {
    // Caching disabled — always hit the provider.
    return loader();
  }

  const key = statusCacheKey(smeId);
  const cached = kycStatusCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const fresh = await loader();
  kycStatusCache.set(key, fresh, ttlMs);
  return fresh;
}

/**
 * Normalizes provider-specific status values to internal KYC statuses.
 *
 * Maps known provider statuses to internal KYC states. If the provider returns
 * a status not in the mapping, gracefully falls back to 'unknown' state and logs
 * the unmapped value for later analysis. This prevents KYC verification failures
 * due to provider status changes or additions.
 *
 * @param {string} status - External provider status.
 * @returns {string} Normalized KYC status. Returns 'unknown' if status is not in the mapping.
 * @throws {Error} If status is missing, null, or not a string.
 *
 * @example
 * normalizeProviderStatus('verified') // => 'verified'
 * normalizeProviderStatus('in_review') // => 'pending'
 * normalizeProviderStatus('new_status_v2') // => 'unknown' (logged)
 * normalizeProviderStatus(null) // => throws Error
 */
function normalizeProviderStatus(status) {
  // Validate input: must be a non-empty string
  if (status === null || status === undefined) {
    logger.warn({ status }, 'Received null or undefined provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }
 
  if (typeof status !== 'string') {
    logger.warn({ status, type: typeof status }, 'Received non-string provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }
 
  const normalized = status.trim().toLowerCase();
 
  // Handle empty string after trim
  if (normalized === '') {
    logger.warn({ originalStatus: status }, 'Received empty provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }
 
  // Check if status is in the mapping
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_STATUS_MAP, normalized)) {
    // Log unmapped status for monitoring and future mapping updates
    logger.warn(
      { unmappedStatus: normalized, originalStatus: status },
      'Provider returned unmapped KYC status, defaulting to unknown. Consider extending PROVIDER_STATUS_MAP.',
    );
    return KYC_STATUSES.UNKNOWN;
  }
 
  return PROVIDER_STATUS_MAP[normalized];
}
 
/**
 * Reads a persisted KYC record from the database.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<null|Object>} Persisted KYC record, or null when missing.
 */
async function readKycRecord(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const row = await db('kyc_records').where({ sme_id: smeId }).first();
  if (!row || !row.status) {
    return null;
  }
 
  return {
    smeId: row.sme_id,
    status: row.status,
    recordId: row.provider_record_id || null,
    verifiedAt: row.verified_at ? row.verified_at.toISOString?.() || row.verified_at : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString?.() || row.updated_at : null,
  };
}
 
/**
 * Persists a KYC status update to the database.
 *
 * @param {Object} params
 * @param {string} params.smeId
 * @param {string} params.status
 * @param {string|null} [params.providerRecordId]
 * @param {string|null} [params.verifiedAt]
 * @returns {Promise<Object>} Persisted KYC state.
 */
async function persistKycRecord({ smeId, status, providerRecordId = null, verifiedAt = null }) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const normalizedStatus = normalizeProviderStatus(status);
  const updatedAt = new Date();
  const record = {
    sme_id: smeId,
    status: normalizedStatus,
    provider_record_id: providerRecordId || null,
    verified_at: verifiedAt || null,
    updated_at: updatedAt,
  };

  // Invalidate the short-TTL cache entry BEFORE writing to DB so that any
  // concurrent reader that checks the cache after this point will miss
  // and consult the DB (or provider) for the fresh status. This prevents
  // a stale cached "verified" from outliving a subsequent revocation write.
  invalidateKycStatusCache(smeId);
 
  const existing = await db('kyc_records').where({ sme_id: smeId }).first();
  if (existing) {
    await db('kyc_records')
      .where({ sme_id: smeId })
      .update(record);
  } else {
    await db('kyc_records').insert(record);
  }
 
  return {
    smeId,
    status: normalizedStatus,
    recordId: providerRecordId || null,
    verifiedAt: verifiedAt || null,
    updatedAt: updatedAt.toISOString(),
  };
}
 
/**
 * Verifies KYC status from external provider.
 * Only called if provider is configured and enabled.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} _smeData - SME metadata from the authenticated principal.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string|null}>}
 */
async function verifyWithExternalProvider(smeId, _smeData) {
  const config = getKycProviderConfig();
 
  if (!config.enabled) {
    throw new Error('KYC provider not configured');
  }
 
  const url = `${config.baseUrl.replace(/\/+$/, '')}/verify`;
 
  const payload = {
    smeId,
    timestamp: new Date().toISOString(),
  };
 
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
 
  if (config.apiSecret) {
    headers['X-KYC-Secret'] = config.apiSecret;
  }
 
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
 
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status}${body ? `: ${body}` : ''}`);
    }
 
    const data = await response.json();
    const recordId = data.recordId || data.providerRecordId || data.provider_record_id || `kyc_${smeId}_${Date.now()}`;
    const verifiedAt = data.verifiedAt || data.verified_at || null;
    const status = normalizeProviderStatus(data.status || data.kycStatus || data.result || '');
 
    const persisted = await persistKycRecord({
      smeId,
      status,
      providerRecordId: recordId,
      verifiedAt,
    });
 
    return {
      status: persisted.status,
      recordId: persisted.recordId,
      verifiedAt: persisted.verifiedAt,
    };
  } catch (error) {
    logger.error({ smeId, error: error.message }, 'External KYC provider call failed');
    throw error;
  }
}
 
/**
 * Gets KYC status for an SME.
 * Checks external provider if available, falls back to persisted DB record or mock store.
 *
 * When the external provider is enabled, status reads are served through a
 * short-TTL cache ({@link readProviderStatusCached}) to avoid hammering the
 * provider during hot funding flows. Cache entries are invalidated on any
 * persisted status change (including KYC webhooks), so a revocation always
 * supersedes a cached approval.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<{status: string, recordId?: string, verifiedAt?: string}>}
 */
async function getKycStatus(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const config = getKycProviderConfig();
 
  if (config.enabled) {
    try {
      return await readProviderStatusCached(smeId, () => verifyWithExternalProvider(smeId, {}));
    } catch (error) {
      logger.warn({ smeId, error: error.message }, 'KYC provider lookup failed, falling back to persisted status');
      const record = await readKycRecord(smeId);
      if (record) {
        return record;
      }
      return { status: KYC_STATUSES.PENDING };
    }
  }
 
  const record = await readKycRecord(smeId);
  if (record) {
    return record;
  }
 
  const mockRecord = mockKycRecords.get(smeId);
  if (mockRecord) {
    return {
      status: mockRecord.status,
      recordId: mockRecord.recordId,
      verifiedAt: mockRecord.verifiedAt,
    };
  }
 
  return { status: KYC_STATUSES.PENDING };
}
 
/**
 * Marks an SME as KYC verified.
 * Only available in test/development (mock implementation).
 * Production should integrate with real KYC provider.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} options - Additional options.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string}>}
 */
async function verifySmeSafe(smeId, options = {}) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const recordId = options.recordId || `kyc_${smeId}_${Date.now()}`;
  const verifiedAt = new Date().toISOString();
  const record = {
    smeId,
    status: KYC_STATUSES.VERIFIED,
    recordId,
    verifiedAt,
    createdAt: verifiedAt,
  };
 
  mockKycRecords.set(smeId, record);
 
  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.VERIFIED,
    providerRecordId: recordId,
    verifiedAt,
  });
 
  logger.info({ smeId, recordId }, 'SME marked as KYC verified');
 
  return {
    status: record.status,
    recordId: record.recordId,
    verifiedAt: record.verifiedAt,
  };
}
 
/**
 * Rejects KYC for an SME (mock implementation).
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for rejection.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function rejectSmeKyc(smeId, reason = 'Manual rejection') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.REJECTED,
    recordId,
    reason,
    rejectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
 
  mockKycRecords.set(smeId, record);
 
  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.REJECTED,
    providerRecordId: recordId,
  });
 
  logger.warn({ smeId, recordId, reason }, 'SME KYC rejected');
 
  return {
    status: record.status,
    recordId: record.recordId,
  };
}
 
/**
 * Exempts an SME from KYC requirements.
 * Typically used for low-risk vendors or when exemption is policy-approved.
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for exemption.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function exemptSmeFromKyc(smeId, reason = 'Manual exemption') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }
 
  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.EXEMPTED,
    recordId,
    reason,
    exemptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
 
  mockKycRecords.set(smeId, record);
 
  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.EXEMPTED,
    providerRecordId: recordId,
  });
 
  logger.info({ smeId, recordId, reason }, 'SME exempted from KYC');
 
  return {
    status: record.status,
    recordId: record.recordId,
  };
}
 
/**
 * Checks if an SME can proceed with funding operations.
 * Returns true ONLY for 'verified' or 'exempted' statuses.
 * Explicitly denies 'unknown', 'pending', and 'rejected' statuses.
 *
 * @param {string} kycStatus - The KYC status string.
 * @returns {boolean} True if KYC status allows funding. False for unknown, pending, and rejected.
 *
 * @example
 * canFundWithKycStatus('verified') // => true
 * canFundWithKycStatus('exempted') // => true
 * canFundWithKycStatus('unknown') // => false
 * canFundWithKycStatus('pending') // => false
 * canFundWithKycStatus('rejected') // => false
 */
function canFundWithKycStatus(kycStatus) {
  return kycStatus === KYC_STATUSES.VERIFIED || kycStatus === KYC_STATUSES.EXEMPTED;
}
 
/**
 * Clears the in-memory mock KYC record store and the external KYC status cache.
 * Intended for tests/dev usage.
 *
 * @returns {void}
 */
function resetMockRecords() {
  mockKycRecords.clear();
  kycStatusCache.clear();
}
 
module.exports = {
  KYC_STATUSES,
  getKycStatus,
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
  verifySmeSafe,
  rejectSmeKyc,
  exemptSmeFromKyc,
  canFundWithKycStatus,
  resetMockRecords,
  getKycProviderConfig,
  normalizeProviderStatus, // Export for direct testing
  getStatusCacheTtlMs, // Export for testing (cache TTL behaviour)
  invalidateKycStatusCache, // Export for testing (cache invalidation)
};