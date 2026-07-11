/**
 * src/services/investorCommitment.js
 *
 * Persists investor commitment records produced by the fund-invoice flow.
 * Uses Knex (the project's existing query builder) so the implementation works
 * with both PostgreSQL (production) and SQLite (test/CI).
 *
 * Table: investor_commitments
 * Schema is created by migration: migrations/YYYYMMDDHHII_create_investor_commitments.js
 *
 * Idempotency: callers may supply an idempotencyKey (e.g. sha256 of
 * investor + invoiceId + amount). Duplicate submissions with the same key
 * return the existing row rather than inserting a second one.
 */

'use strict';

const db = require('../db/knex');
const { isValidStellarAddress } = require('../utils/validators');

const TABLE = 'investor_commitments';

// Sane upper bound: 10^18 stroops (≈ 10 billion XLM — exceeds total supply)
const MAX_STROOP_AMOUNT = 10n ** 18n;

/**
 * Typed error thrown when commitment input fails validation.
 * Callers can use `instanceof CommitmentValidationError` to distinguish
 * domain errors from unexpected runtime failures.
 */
class CommitmentValidationError extends Error {
  /**
   * Constructs a CommitmentValidationError.
   * @param {string} message - Human-readable description.
   * @param {string} code    - Machine-readable error code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'CommitmentValidationError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Normalize and validate amountStroops from route input (number or string).
 * Returns the canonical decimal string used by persistence and Soroban calls.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {CommitmentValidationError}
 */
function normalizeAmountStroopsInput(value) {
  let candidate;

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new CommitmentValidationError(
        'amountStroops must be a positive integer representing the fund amount in stroops.',
        'INVALID_AMOUNT_RANGE'
      );
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new CommitmentValidationError(
        'amountStroops exceeds JavaScript safe integer range; pass a decimal string instead.',
        'INVALID_AMOUNT_TYPE'
      );
    }
    candidate = String(value);
  } else if (typeof value === 'string') {
    candidate = value;
  } else {
    throw new CommitmentValidationError(
      `amountStroops must be a string or safe integer, got ${value === null ? 'null' : typeof value}`,
      'INVALID_AMOUNT_TYPE'
    );
  }

  validateAmountStroops(candidate);
  return candidate;
}

/**
 * Validate that a value is a safe positive integer string suitable for
 * on-chain stroop math.
 *
 * Rules:
 *  - Must be a `string` (never coerced — callers must convert first)
 *  - Must contain only ASCII decimal digits (no sign, no decimal point,
 *    no scientific notation, no whitespace)
 *  - Must not have leading zeros (e.g. "007" is rejected)
 *  - Must be strictly positive (> 0)
 *  - Must not exceed MAX_STROOP_AMOUNT (10^18 stroops ≈ 10 billion XLM)
 *
 * @param {unknown} value - The candidate amount value.
 * @throws {CommitmentValidationError} When the value is not a valid stroop amount.
 */
function validateAmountStroops(value) {
  if (typeof value !== 'string') {
    throw new CommitmentValidationError(
      `amountStroops must be a string, got ${typeof value}`,
      'INVALID_AMOUNT_TYPE'
    );
  }

  if (!/^\d+$/.test(value)) {
    throw new CommitmentValidationError(
      'amountStroops must contain only decimal digits (no sign, decimals, or spaces)',
      'INVALID_AMOUNT_FORMAT'
    );
  }

  // Reject leading zeros ("007", "00") but allow "0" itself for the zero check below
  if (value.length > 1 && value[0] === '0') {
    throw new CommitmentValidationError(
      'amountStroops must not have leading zeros',
      'INVALID_AMOUNT_FORMAT'
    );
  }

  const big = BigInt(value);

  if (big <= 0n) {
    throw new CommitmentValidationError(
      'amountStroops must be a positive integer (> 0)',
      'INVALID_AMOUNT_RANGE'
    );
  }

  if (big > MAX_STROOP_AMOUNT) {
    throw new CommitmentValidationError(
      `amountStroops exceeds maximum allowed value (${MAX_STROOP_AMOUNT.toString()})`,
      'INVALID_AMOUNT_OVERFLOW'
    );
  }
}

/**
 * Validate a Stellar StrKey address (G... account or C... contract).
 *
 * @param {string} address - The candidate Stellar address.
 * @returns {{ valid: boolean, reason: string }} Result object.
 */
function validateAddress(address) {
  if (!address || typeof address !== 'string') {
    return { valid: false, reason: 'invalid Stellar address: must be a non-empty string' };
  }
  if (!isValidStellarAddress(address)) {
    return {
      valid: false,
      reason: 'invalid Stellar address: must start with G or C and be 56 base-32 characters',
    };
  }
  return { valid: true, reason: '' };
}

/**
 * @typedef {Object} CommitmentRecord
 * @property {string}  id
 * @property {string}  invoice_id
 * @property {string}  investor_address
 * @property {string}  escrow_address
 * @property {string}  amount_stroops      — integer string
 * @property {'requires_signature'|'submitted'|'stubbed'} status
 * @property {string|null} unsigned_xdr
 * @property {string|null} tx_hash
 * @property {string|null} ledger
 * @property {string|null} idempotency_key
 * @property {Date}    created_at
 * @property {Date}    updated_at
 */

/**
 * Persist a new commitment, or return the existing one when the idempotency
 * key matches a prior row.
 *
 * @param {Object} params
 * @param {string} params.invoiceId
 * @param {string} params.investorAddress
 * @param {string} params.escrowAddress
 * @param {string} params.amountStroops   — must be a valid positive integer string
 * @param {'requires_signature'|'submitted'|'stubbed'} params.status
 * @param {string|null} [params.unsignedXdr]
 * @param {string|null} [params.txHash]
 * @param {string|null} [params.ledger]
 * @param {string|null} [params.idempotencyKey]
 * @returns {Promise<CommitmentRecord>}
 * @throws {CommitmentValidationError} When inputs fail validation.
 */
async function persistCommitment({
  invoiceId,
  investorAddress,
  escrowAddress,
  amountStroops,
  status,
  unsignedXdr = null,
  txHash = null,
  ledger = null,
  idempotencyKey = null,
}) {
  // Validate amount — throws CommitmentValidationError for any invalid format
  validateAmountStroops(amountStroops);

  // Validate investor address
  const addrResult = validateAddress(investorAddress);
  if (!addrResult.valid) {
    throw new CommitmentValidationError(addrResult.reason, 'INVALID_INVESTOR_ADDRESS');
  }

  // Idempotency check: return early if we've already processed this exact request
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first();
    if (existing) {
      return existing;
    }
  }

  const [row] = await db(TABLE)
    .insert({
      invoice_id: invoiceId,
      investor_address: investorAddress,
      escrow_address: escrowAddress,
      amount_stroops: amountStroops,
      status,
      unsigned_xdr: unsignedXdr,
      tx_hash: txHash,
      ledger,
      idempotency_key: idempotencyKey,
    })
    .returning('*');

  return row;
}

/**
 * Update the status of an existing commitment (e.g. once the investor submits
 * the signed XDR and we observe the ledger result).
 *
 * amount_stroops is immutable after creation — passing it in fields violates
 * idempotency and is rejected with a typed error.
 *
 * @param {string} id        — commitment UUID
 * @param {Partial<CommitmentRecord>} fields
 * @returns {Promise<CommitmentRecord>}
 * @throws {CommitmentValidationError} When fields attempts to change amount_stroops.
 */
async function updateCommitment(id, fields) {
  if ('amount_stroops' in fields || 'amountStroops' in fields) {
    throw new CommitmentValidationError(
      'amount_stroops is immutable after commitment creation and cannot be updated',
      'AMOUNT_IMMUTABLE'
    );
  }

  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*');
  if (!row) {
    throw new Error(`Commitment not found: ${id}`);
  }
  return row;
}

  /**
   * Find commitments for a given investor and invoice.
   *
   * @param {string} investorAddress
   * @param {string} invoiceId
   * @returns {Promise<CommitmentRecord[]>}
   */
  async function findCommitments(investorAddress, invoiceId) {
    return db(TABLE).where({ investor_address: investorAddress, invoice_id: invoiceId }).orderBy('created_at', 'desc');
  }

// ── In-memory investor lock store ─────────────────────────────────────────────
// Keys are "${invoiceId}:${funderAddress}" for O(1) lookup.

/** @type {Map<string, Object>} */
const _lockStore = new Map();

/**
 * Upsert a lock record into the in-memory store.
 *
 * @param {Object} params
 * @param {string} params.funderAddress
 * @param {string} params.claimNotBefore
 * @param {number} params.investorEffectiveYieldBps
 * @param {string} params.invoiceId
 * @returns {Object} The stored lock record.
 */
function setInvestorLock({ funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId }) {
  const key = `${invoiceId}:${funderAddress}`;
  const record = { funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId, stale: true };
  _lockStore.set(key, record);
  return record;
}

/**
 * Retrieve a single lock by invoiceId and funderAddress.
 *
 * @param {string} invoiceId
 * @param {string} funderAddress
 * @returns {Object|undefined}
 */
function getInvestorLock(invoiceId, funderAddress) {
  return _lockStore.get(`${invoiceId}:${funderAddress}`);
}

/**
 * Returns all locks, optionally filtered by invoiceId, with offset pagination.
 *
 * @param {Object} [opts]
 * @param {string} [opts.invoiceId]  - Optional invoiceId filter.
 * @param {number} [opts.limit=20]   - Page size (1–100).
 * @param {number} [opts.page=1]     - 1-based page number.
 * @returns {{ data: Object[], meta: { total: number, page: number, limit: number, totalPages: number, hasMore: boolean } }}
 */
function getAllInvestorLocks({ invoiceId, limit = 20, page = 1 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const safePage = Math.max(1, page);
  let items = [..._lockStore.values()];
  if (invoiceId) {
    items = items.filter((l) => l.invoiceId === invoiceId);
  }
  const total = items.length;
  const offset = (safePage - 1) * safeLimit;
  const data = items.slice(offset, offset + safeLimit);
  return {
    data,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
      hasMore: offset + data.length < total,
    },
  };
}

/**
 * Returns all locks for a specific funderAddress, optionally filtered by invoiceId,
 * with offset pagination.
 *
 * @param {string} funderAddress
 * @param {Object} [opts]
 * @param {string} [opts.invoiceId]  - Optional invoiceId filter.
 * @param {number} [opts.limit=20]   - Page size (1–100).
 * @param {number} [opts.page=1]     - 1-based page number.
 * @returns {{ data: Object[], meta: { total: number, page: number, limit: number, totalPages: number, hasMore: boolean } }}
 */
function getInvestorLocksByAddress(funderAddress, { invoiceId, limit = 20, page = 1 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const safePage = Math.max(1, page);
  let items = [..._lockStore.values()].filter((l) => l.funderAddress === funderAddress);
  if (invoiceId) {
    items = items.filter((l) => l.invoiceId === invoiceId);
  }
  const total = items.length;
  const offset = (safePage - 1) * safeLimit;
  const data = items.slice(offset, offset + safeLimit);
  return {
    data,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
      hasMore: offset + data.length < total,
    },
  };
}

/** Clear all locks (test helper). */
function clearInvestorLocks() {
  _lockStore.clear();
}

/** Seed representative test fixtures (test helper). */
function seedInvestorLocks() {
  const addr1 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
  const addr2 = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

  for (let i = 1; i <= 5; i++) {
    setInvestorLock({ funderAddress: addr1, claimNotBefore: `2026-0${i}-01T00:00:00Z`, investorEffectiveYieldBps: 500 + i * 50, invoiceId: `inv_${7788 + i - 1}` });
  }
  setInvestorLock({ funderAddress: addr2, claimNotBefore: '2026-06-01T00:00:00Z', investorEffectiveYieldBps: 800, invoiceId: 'inv_9900' });
}

module.exports = {
  persistCommitment,
  updateCommitment,
  findCommitments,
  validateAddress,
  validateAmountStroops,
  normalizeAmountStroopsInput,
  CommitmentValidationError,
  setInvestorLock,
  getInvestorLock,
  getAllInvestorLocks,
  getInvestorLocksByAddress,
  clearInvestorLocks,
  seedInvestorLocks,
};
