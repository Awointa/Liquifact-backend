'use strict';

/**
 * @fileoverview Logger utility using Pino for structured JSON logging.
 *
 * Provides a consistent logging interface with support for:
 * - Structured JSON output (for production log aggregation)
 * - Pretty printing (for local development)
 * - Standardized log levels
 * - Request correlation via request IDs
 * - Automatic enrichment from the AsyncLocalStorage request context
 *   (requestId, correlationId, tenantId, userId) with no manual threading.
 *
 * @module logger
 */

const pino = require('pino');
const { get: getContext } = require('./requestContext');

/**
 * Configure the Pino logger instance.
 *
 * In production, this outputs raw JSON. In development (when NODE_ENV is not 'production'),
 * it can use pino-pretty if available.
 */
const transport =
  process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

const _base = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'liquifact-api',
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
  },
  transport ? pino.transport(transport) : undefined
);

/**
 * Logger instance with stable own level methods. Keeping the wrappers as
 * assignable properties lets Jest spy on `logger.warn` without recursing back
 * through the wrapped Pino method.
 *
 * @type {import('pino').Logger}
 */
const logger = _base;
const LEVEL_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

for (const level of LEVEL_METHODS) {
  const write = _base[level].bind(_base);

  logger[level] = function enrichedLog(objOrMsg, ...rest) {
    const ctx = getContext();
    const hasCtx = Object.keys(ctx).length > 0;

    if (!hasCtx) {
      return write(objOrMsg, ...rest);
    }

    if (typeof objOrMsg === 'string') {
      return write({ ...ctx }, objOrMsg, ...rest);
    }

    if (objOrMsg && typeof objOrMsg === 'object') {
      return write({ ...ctx, ...objOrMsg }, ...rest);
    }

    return write(objOrMsg, ...rest);
  };
}

/**
 * Create a per-request child logger bound only with safe correlation fields.
 *
 * @param {import('express').Request | undefined} req - Express request object.
 * @returns {import('pino').Logger} A child logger scoped to the request.
 */
function createRequestLogger(req) {
  const bindings = {};

  if (typeof req?.id === 'string' && req.id) {
    bindings.requestId = req.id;
  }

  if (typeof req?.correlationId === 'string' && req.correlationId) {
    bindings.correlationId = req.correlationId;
  }

  return _base.child(bindings);
}

logger.createRequestLogger = createRequestLogger;

module.exports = logger;
module.exports.createRequestLogger = createRequestLogger;
