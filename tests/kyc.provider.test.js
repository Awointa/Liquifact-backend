'use strict';

/**
 * Tests for KYC provider integration and persistence.
 *
 * Covers:
 *  1. Provider success — status persisted and returned
 *  2. Provider failure — falls back to persisted record (fail-closed)
 *  3. Persistence read-back — getKycStatus returns DB record when provider is off
 *  4. Funding denied when status is pending or rejected
 */

jest.mock('../src/db/knex');

const db = require('../src/db/knex');
const {
  KYC_STATUSES,
  getKycStatus,
  canFundWithKycStatus,
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
} = require('../src/services/kycService');
const { createSignatureHeader } = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.KYC_PROVIDER_URL;
  delete process.env.KYC_PROVIDER_API_KEY;
  delete process.env.KYC_PROVIDER_SECRET;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function enableProvider() {
  process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
  process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
}

function mockFetchOk(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function mockFetchFail(status = 503) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  });
}

// ── 1. Provider success ───────────────────────────────────────────────────────

describe('provider success', () => {
  beforeEach(() => {
    enableProvider();
    mockFetchOk({
      status: 'verified',
      recordId: 'rec_abc123',
      verifiedAt: '2026-05-27T10:00:00.000Z',
    });
    // DB: no existing row → insert path
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));
  });

  it('calls the provider with the correct URL and auth header', async () => {
    await getKycStatus('sme-001');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://kyc.example.com/verify');
    expect(opts.headers.Authorization).toBe('Bearer test-api-key');
    expect(opts.method).toBe('POST');
  });

  it('returns the provider status', async () => {
    const result = await getKycStatus('sme-001');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_abc123');
  });

  it('does not leak the API key in the returned object', async () => {
    const result = await getKycStatus('sme-001');
    expect(JSON.stringify(result)).not.toContain('test-api-key');
  });

  it('persists the result to the database', async () => {
    await getKycStatus('sme-001');
    // db() was called for the upsert (first + insert)
    expect(db).toHaveBeenCalledWith('kyc_records');
  });
});

// ── 2. Provider failure — fail-closed ────────────────────────────────────────

describe('provider failure fallback', () => {
  it('returns persisted record when provider returns 5xx', async () => {
    enableProvider();
    mockFetchFail(503);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'verified',
        provider_record_id: 'rec_old',
        verified_at: '2026-01-01T00:00:00.000Z',
      }),
      insert: jest.fn(),
      update: jest.fn(),
    }));

    const result = await getKycStatus('sme-002');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_old');
  });

  it('returns pending when provider fails and no DB record exists', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-003');
    expect(result.status).toBe(KYC_STATUSES.PENDING);
  });

  it('does not throw — always returns a status object', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    await expect(getKycStatus('sme-004')).resolves.toMatchObject({ status: expect.any(String) });
  });
});

// ── 3. Persistence read-back ──────────────────────────────────────────────────

describe('persistence read-back', () => {
  it('returns DB record when provider is not configured', async () => {
    // No KYC_PROVIDER_URL / KYC_PROVIDER_API_KEY set
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'exempted',
        provider_record_id: 'rec_exempt',
        verified_at: null,
      }),
    }));

    const result = await getKycStatus('sme-005');
    expect(result.status).toBe('exempted');
    expect(result.recordId).toBe('rec_exempt');
  });

  it('returns pending when provider is off and no DB record', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-006');
    expect(result.status).toBe(KYC_STATUSES.PENDING);
  });

  it('readKycRecord maps DB columns to camelCase fields', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'verified',
        provider_record_id: 'rec_xyz',
        verified_at: '2026-05-01T00:00:00.000Z',
      }),
    }));

    const record = await readKycRecord('sme-007');
    expect(record.status).toBe('verified');
    expect(record.recordId).toBe('rec_xyz');
    expect(record.verifiedAt).toMatch(/2026-05-01/);
  });

  it('readKycRecord returns null when no row found', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const record = await readKycRecord('sme-missing');
    expect(record).toBeNull();
  });
});

// ── 4. Funding gate ───────────────────────────────────────────────────────────

describe('canFundWithKycStatus', () => {
  it('allows funding for verified', () => {
    expect(canFundWithKycStatus('verified')).toBe(true);
  });

  it('allows funding for exempted', () => {
    expect(canFundWithKycStatus('exempted')).toBe(true);
  });

  it('denies funding for pending', () => {
    expect(canFundWithKycStatus('pending')).toBe(false);
  });

  it('denies funding for rejected', () => {
    expect(canFundWithKycStatus('rejected')).toBe(false);
  });

  it('denies funding for unknown/undefined status', () => {
    expect(canFundWithKycStatus(undefined)).toBe(false);
    expect(canFundWithKycStatus('')).toBe(false);
  });
});

// ── 5. Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('throws on missing smeId', async () => {
    await expect(getKycStatus('')).rejects.toThrow('Invalid SME ID');
  });

  it('throws on non-string smeId', async () => {
    await expect(getKycStatus(123)).rejects.toThrow('Invalid SME ID');
  });
});

// ── 6. verifyWithExternalProvider — unit ─────────────────────────────────────

describe('verifyWithExternalProvider', () => {
  it('throws when provider is not configured', async () => {
    await expect(verifyWithExternalProvider('sme-x', {})).rejects.toThrow(
      'KYC provider not configured'
    );
  });

  it('throws on non-ok response', async () => {
    enableProvider();
    mockFetchFail(400);
    await expect(verifyWithExternalProvider('sme-x', {})).rejects.toThrow('400');
  });

  it('includes X-KYC-Secret header when secret is set', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'my-secret';
    mockFetchOk({ status: 'verified', recordId: 'r1', verifiedAt: null });

    await verifyWithExternalProvider('sme-x', {});

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-KYC-Secret']).toBe('my-secret');

    delete process.env.KYC_PROVIDER_SECRET;
  });
});

describe('KYC webhook route', () => {
  let app;

  beforeEach(() => {
    app = require('express')();
    app.use(require('express').raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', kycRoutes);
  });

  it('accepts valid signed webhook payload and persists the record', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-01',
      status: 'approved',
      recordId: 'rec_webhook_01',
      verifiedAt: '2026-06-24T12:00:00.000Z',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const where = jest.fn().mockReturnThis();
    const first = jest.fn().mockResolvedValue(null);
    const insert = jest.fn().mockResolvedValue([1]);
    const update = jest.fn().mockResolvedValue(1);

    db.mockImplementation(() => ({ where, first, insert, update }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('verified');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sme_id: 'sme-webhook-01' }));
  });

  it('rejects webhook with invalid signature', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-02',
      status: 'approved',
    };
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 't=123,v1=deadbeef')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid webhook signature/);
  });

  it('rejects webhook with unknown provider status', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-03',
      status: 'mystery_status',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown provider status/);
  });

  it('accepts repeated webhook deliveries without failing', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-04',
      status: 'approved',
      recordId: 'rec_webhook_04',
      verifiedAt: '2026-06-24T12:00:00.000Z',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const where = jest.fn().mockReturnThis();
    const first = jest.fn().mockResolvedValue({ sme_id: 'sme-webhook-04' });
    const insert = jest.fn();
    const update = jest.fn().mockResolvedValue(1);

    db.mockImplementation(() => ({ where, first, insert, update }));

    const firstResponse = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    const secondResponse = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
