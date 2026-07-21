'use strict';

/**
 * @fileoverview OpenAPI specification builder.
 *
 * Generates the LiquiFact API OpenAPI 3.0 document by scanning the `@swagger`
 * JSDoc annotations in `src/routes/**` and merging them with the shared
 * components defined below (standardized envelope, RFC 7807 problem details,
 * security scheme, common parameters).
 *
 * The generated spec is the single source of truth used by both the contract
 * tests (`tests/contract/api-schemas.test.js`) and the OpenAPI tests
 * (`tests/openapi.test.js`).
 *
 * @module openapi/openapiSpec
 */

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const ROUTES_GLOB = path.join(__dirname, '..', 'routes', '**', '*.js');

/**
 * Base OpenAPI document. Route-specific operations are merged in by
 * `swagger-jsdoc` from the `@swagger` JSDoc blocks in route files.
 */
const baseDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'LiquiFact API',
    version: '1.0.0',
    description:
      'Global Invoice Liquidity Network on Stellar. ' +
      'Successful responses use a standardized envelope (`data`/`meta`/`message`); ' +
      'error responses follow RFC 7807 (`application/problem+json`).',
  },
  servers: [{ url: 'http://localhost:3001', description: 'Local development' }],
  /**
   * Top-level tag definitions used by all route operations.
   * Every documented operation must reference one of these tags.
   * Tags are used by client SDK generators (e.g. openapi-typescript-codegen)
   * to group operations into service classes.
   */
  tags: [
    { name: 'Invoices', description: 'Invoice management — create, read, update, delete, and file operations.' },
    { name: 'Marketplace', description: 'Marketplace browse — search, filter, and paginate investable invoices.' },
    { name: 'Invest', description: 'Investment operations — funding opportunities and invoice funding.' },
    { name: 'Investor', description: 'Investor lock management — funder commitment and lock records.' },
    { name: 'Admin', description: 'Administrative operations — reconciliation, escrow management, webhook replay, audit exports.' },
    { name: 'KYC', description: 'Know-Your-Customer integration — webhook ingestion from the KYC provider.' },
    { name: 'Escrow', description: 'Escrow contract operations — state reads, version checks, and refresh.' },
    { name: 'SME', description: 'SME dashboard — metrics, invoice uploads, and presigned URL generation.' },
    { name: 'Reconciliation', description: 'Escrow reconciliation — run history for admin review.' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      /**
       * Reusable invoice projection used by the marketplace and invoice
       * list endpoints. Kept permissive so it tolerates additional columns
       * surfaced by `marketplaceService`.
       */
      Invoice: {
        type: 'object',
        additionalProperties: true,
      },
      /**
       * Read-side projection of the on-chain LiquifactEscrow contract.
       */
      EscrowState: {
        type: 'object',
        additionalProperties: true,
      },
      /**
       * Standardized success envelope used by routes wired through
       * `createStandardizedApp` and by the marketplace/invest routes.
       */
      StandardEnvelope: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: {},
          meta: {
            type: 'object',
            additionalProperties: true,
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `GET /api/marketplace`.
       */
      MarketplaceListResponse: {
        type: 'object',
        required: ['data', 'meta', 'message'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } },
          meta: {
            type: 'object',
            required: ['total', 'page', 'limit'],
            properties: {
              total: { type: 'integer', minimum: 0 },
              page: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              totalPages: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
      },
      /**
       * Successful response from `POST /api/invest/fund-invoice`.
       */
      FundInvoiceResponse: {
        type: 'object',
        required: ['data', 'meta', 'message'],
        properties: {
          data: {
            type: 'object',
            required: ['investmentId', 'invoiceId', 'status'],
            properties: {
              investmentId: { type: 'string', minLength: 1 },
              invoiceId: { type: 'string', minLength: 1 },
              smeId: { type: 'string' },
              investmentAmount: { type: 'number', exclusiveMinimum: 0 },
              status: {
                type: 'string',
                enum: ['pending', 'confirmed', 'escrow', 'settled'],
              },
              onChain: {
                type: 'object',
                properties: {
                  escrowAddress: { type: 'string' },
                  ledgerIndex: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp'],
            properties: {
              timestamp: { type: 'string', format: 'date-time' },
              version: { type: 'string' },
              kycVerified: { type: 'boolean' },
              kycStatus: { type: 'string' },
            },
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
      },
      /**
       * RFC 7807 problem details envelope. Returned for 4xx/5xx responses
       * from routes that flow through `problemJsonHandler`.
       *
       * @see https://tools.ietf.org/html/rfc7807
       */
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status'],
        properties: {
          type: { type: 'string', format: 'uri-reference' },
          title: { type: 'string' },
          status: { type: 'integer', minimum: 100, maximum: 599 },
          detail: { type: 'string' },
          instance: { type: 'string' },
          code: { type: 'string' },
          retryable: { type: 'boolean' },
          retry_hint: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Summary row from the `reconciliation_runs` table.
       * Intentionally excludes the per-invoice `results` column so that
       * raw on-chain funding values are not surfaced in bulk list responses.
       */
      ReconciliationRun: {
        type: 'object',
        required: ['id', 'total', 'matches', 'mismatches', 'errors', 'reconciled_at', 'created_at'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Unique identifier for the reconciliation run.',
          },
          total: {
            type: 'integer',
            minimum: 0,
            description: 'Total number of invoices inspected in this run.',
          },
          matches: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices where DB and on-chain funded amounts matched.',
          },
          mismatches: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices where a funded-amount discrepancy was detected.',
          },
          errors: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices that could not be compared due to an error.',
          },
          reconciled_at: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp when the reconciliation run completed.',
          },
          created_at: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp when the row was inserted.',
          },
        },
        additionalProperties: false,
      },
    },
    responses: {
      Problem400: {
        description: 'Validation error (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
      Problem401: {
        description: 'Unauthorized (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
      Problem403: {
        description: 'Forbidden — typically KYC gate failure (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
    },
  },
  paths: {},
};

let cached = null;

/**
 * Build the OpenAPI document. The result is memoised because spec generation
 * walks every route file with `swagger-jsdoc` and is non-trivial.
 *
 * Performs build-time validation:
 * - Every documented operation must have a unique `operationId`.
 * - No two operations can share the same `operationId`.
 * - Operations missing `operationId` are flagged as build errors.
 *
 * @returns {object} OpenAPI 3.0 document.
 * @throws {Error} When validation fails (duplicate or missing operationIds).
 */
function buildOpenApiSpec() {
  if (cached) {
    return cached;
  }

  const generated = swaggerJsdoc({
    definition: baseDefinition,
    apis: [ROUTES_GLOB],
  });

  // ── operationId Validation ─────────────────────────────────────────────────
  // Client SDK generators (openapi-typescript-codegen, @openapitools/openapi-generator-cli)
  // require every operation to have a unique operationId. Duplicate or missing
  // operationIds break SDK method generation and cause client-side confusion.

  const seenOperationIds = new Map(); // operationId -> { path, method }
  const missing = []; // { path, method }

  for (const [path, pathItem] of Object.entries(generated.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const operationId = operation.operationId;

      if (!operationId) {
        missing.push({ path, method: method.toUpperCase() });
      } else {
        const firstSeen = seenOperationIds.get(operationId);
        if (firstSeen) {
          throw new Error(
            `Duplicate operationId "${operationId}" found:\n` +
              `  First:  ${firstSeen.method} ${firstSeen.path}\n` +
              `  Second: ${method.toUpperCase()} ${path}\n` +
              `Every operation must have a unique operationId.`,
          );
        }
        seenOperationIds.set(operationId, { path, method: method.toUpperCase() });
      }
    }
  }

  if (missing.length > 0) {
    const lines = missing.map(({ path, method }) => `  ${method} ${path}`);
    throw new Error(
      `The following operations are missing an operationId:\n${lines.join('\n')}\n\n` +
        `Add a unique operationId to each @swagger JSDoc block.\n` +
        `Example:\n` +
        `  @swagger\n` +
        `  /api/marketplace:\n` +
        `    get:\n` +
        `      operationId: listMarketplaceInvoices\n` +
        `      summary: ...\n`,
    );
  }

  cached = generated;
  return generated;
}

/**
 * Reset the memoised spec. Exposed for tests that mutate the spec.
 *
 * @returns {void}
 */
function _resetCache() {
  cached = null;
}

module.exports = {
  buildOpenApiSpec,
  baseDefinition,
  _resetCache,
};
