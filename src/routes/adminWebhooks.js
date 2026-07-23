'use strict';

/**
 * @fileoverview Admin routes for webhook dead-letter replay.
 *
 * All routes require either a valid admin JWT (`Authorization: Bearer <token>`)
 * or a valid API key (`X-API-Key`). Unauthorized callers receive 401/403.
 *
 * Routes
 * ──────
 * POST /api/admin/webhooks/replay/:id
 *   Enqueue a single dead-letter row for immediate replay.
 *
 * POST /api/admin/webhooks/replay
 *   Enqueue a batch of dead-letter rows for replay (by id list or filter).
 *
 * POST /api/admin/webhooks/resolve/:id
 *   Mark a dead-letter row as resolved without re-sending.
 *
 * @module routes/adminWebhooks
 */

const express = require('express');
const router = express.Router();
const db = require('../db/knex');
const { replayWebhook, resolveDeadLetter } = require('../services/webhooks');
const { webhookReplayTotal } = require('../metrics');
const { authenticateToken } = require('../middleware/auth');
// Legacy src/middleware/apiKey.js has been retired in favour of the env-backed
// registry authenticator. The implementation lives in apiKeyAuth.js and never
// opens a SQLite connection per request — see issue #590.
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const logger = require('../logger');

/**
 * Pre-built admin API key middleware (no required scope — any valid, non-revoked
 * key is accepted). Built once so the factory overhead is paid at module load
 * rather than on every request.
 *
 * @type {import('express').RequestHandler}
 */
const _adminApiKeyMiddleware = authenticateApiKey();

/**
 * Accepts either a valid admin JWT or a valid X-API-Key.
 * Honours the existing X-API-KEY contract: when the header is present the
 * request is authenticated against the env-backed key registry; otherwise it
 * falls through to JWT auth.
 *
 * @type {import('express').RequestHandler}
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return _adminApiKeyMiddleware(req, res, next);
  }
  return authenticateToken(req, res, next);
}

/**
 * POST /api/admin/webhooks/replay/:id
 * Replay a single dead-letter row by its UUID.
 */
router.post('/replay/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await replayWebhook(id);
    // `req.apiClient` is set by src/middleware/apiKeyAuth.js on success; the
    // JWT path sets `req.user`. The legacy `req.apiKey` no longer exists.
    logger.info({ deadLetterId: id, adminClient: req.apiClient?.clientId || req.user?.sub }, 'Admin triggered replay');
    return res.status(202).json({ replayed: [id] });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: `Dead-letter row not found: ${id}` });
    }
    if (err.code === 'ALREADY_RESOLVED') {
      return res.status(409).json({ error: `Dead-letter row already resolved: ${id}` });
    }
    logger.error({ deadLetterId: id, err: err.message }, 'Admin replay failed');
    return res.status(502).json({ error: `Replay failed: ${err.message}` });
  }
});

/**
 * POST /api/admin/webhooks/replay
 * Replay a batch of dead-letter rows.
 *
 * Body (one of):
 *   { "ids": ["uuid1", "uuid2"] }           — explicit list
 *   { "tenantId": "t_123" }                 — all unresolved for tenant
 *   { "tenantId": "t_123", "limit": 50 }    — with page limit (max 200)
 */
router.post('/replay', adminAuth, async (req, res) => {
  const { ids, tenantId, limit = 50 } = req.body || {};

  if (!ids && !tenantId) {
    return res.status(400).json({ error: 'Provide either "ids" array or "tenantId" filter.' });
  }

  let rows;
  if (ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '"ids" must be a non-empty array.' });
    }
    // cap batch to 200 to prevent DoS
    const capped = ids.slice(0, 200);
    rows = await db('webhook_dead_letters')
      .whereIn('id', capped)
      .where('resolved', false)
      .select('id');
  } else {
    const cap = Math.min(Number(limit) || 50, 200);
    rows = await db('webhook_dead_letters')
      .where({ tenant_id: tenantId, resolved: false })
      .orderBy('created_at', 'asc')
      .limit(cap)
      .select('id');
  }

  const replayed = [];
  const failed = [];

  for (const row of rows) {
    try {
      await replayWebhook(row.id);
      replayed.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, error: err.message });
      webhookReplayTotal.inc({ outcome: err.code === 'ALREADY_RESOLVED' ? 'already_resolved' : 'failure' });
    }
  }

  logger.info(
    { replayed: replayed.length, failed: failed.length, adminClient: req.apiClient?.clientId || req.user?.sub },
    'Admin batch replay completed'
  );

  return res.status(202).json({ replayed, failed });
});

/**
 * POST /api/admin/webhooks/resolve/:id
 * Mark a dead-letter row as resolved without re-sending.
 */
router.post('/resolve/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const row = await db('webhook_dead_letters').where('id', id).first();
  if (!row) {
    return res.status(404).json({ error: `Dead-letter row not found: ${id}` });
  }
  if (row.resolved) {
    return res.status(409).json({ error: `Dead-letter row already resolved: ${id}` });
  }
  await resolveDeadLetter(id);
  logger.info({ deadLetterId: id, adminClient: req.apiClient?.clientId || req.user?.sub }, 'Admin resolved dead-letter without replay');
  return res.status(200).json({ resolved: id });
});

module.exports = router;
