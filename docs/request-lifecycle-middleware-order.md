# Request lifecycle and middleware order

This document describes the request path assembled by
[`src/app.js`](../src/app.js) and the reusable route stacks in
[`src/middleware/stacks.js`](../src/middleware/stacks.js). Treat it as the
source map for debugging ordering-sensitive behavior such as body parsing,
authentication, tenant extraction, KYC gates, legal-hold checks, idempotency,
metrics, and error normalization.

## Application wrapper

The exported app is created by `createStandardizedApp()`. That wrapper installs
one outer middleware before the raw application returned by `createApp()`:

| Order | Layer | Effect |
|-------|-------|--------|
| 0 | response-envelope wrapper | Replaces `res.json()` so successful and error JSON payloads are normalized through `toStandardEnvelope()` before they leave the process. |
| 1 | raw LiquiFact app | Delegates to the `createApp()` instance described below. |

The wrapper does not reorder the routes or middleware inside `createApp()`.

## Global middleware before routes

Every request entering `createApp()` sees these global layers before inline
routes or feature routers are evaluated:

| Order | Middleware | Source | Purpose |
|-------|------------|--------|---------|
| 1 | CORS | `cors(createCorsOptions())` | Applies the environment-driven origin allowlist. Rejected origins are normalized later by `handleCorsError`. |
| 2 | KYC webhook raw body parser | `express.raw({ type: 'application/json', limit: '100kb' })` on `/api/kyc/webhook` | Preserves the provider webhook body for signature verification before the global JSON parser consumes it. |
| 3 | JSON body guard and parser | `...jsonBodyLimit()` | Applies the global JSON body cap, defaulting to 100 KB. |
| 4 | URL-encoded body guard and parser | `...urlencodedBodyLimit()` | Applies the form body cap, defaulting to 50 KB. |
| 5 | Security headers | `createSecurityMiddleware()` | Applies Helmet headers, using the docs CSP for `/api-docs` and `/docs`, and the stricter default CSP elsewhere. |
| 6 | Audit middleware | `auditMiddleware` | Wraps successful API mutations (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) with fire-and-forget audit logging. It skips non-API requests and read-only methods. |
| 7 | Request ID | `requestId` | Resolves or generates the canonical request id and writes it to `req.id` and `req.correlationId`. |
| 8 | Correlation ID | `correlationIdMiddleware` | Echoes the canonical id in `X-Correlation-Id` and refreshes request-scoped logger bindings. |

### Request identifier contract

`requestId` accepts a client-supplied `X-Request-Id`, `request-id`, or
`X-Correlation-Id` only when the value is 8 to 64 characters long and uses the
safe character set `[A-Za-z0-9_-]`. `X-Request-Id` and `request-id` take
precedence over `X-Correlation-Id`. If no inbound value is trusted, the server
generates a `req_` identifier from UUID entropy.

### Body-size behavior

The JSON, URL-encoded, and invoice body guards reject a request early only when
a trustworthy `Content-Length` exceeds the configured limit. Missing, malformed,
or chunked lengths continue to the Express parser, which still enforces the same
byte cap. Parser-raised 413 responses reuse the stored limit context so
`bodySizeLimitRejectionsTotal` keeps the correct `json`, `urlencoded`, or
`invoice` label.

`POST /api/invoices` adds a route-local `...invoiceBodyLimit()` after the
global JSON parser. That route-local guard records the stricter `invoice` limit
for metrics and protects the invoice creation handler from oversized payloads.

## Inline routes

Inline routes are registered directly on the app before any feature router is
mounted:

| Order | Route(s) | Notes |
|-------|----------|-------|
| 1 | `GET /health`, `GET /healthz` | Liveness probes with no external dependency checks. |
| 2 | `GET /ready`, `GET /readyz` | Dependency/readiness probes. |
| 3 | `GET /api` | API metadata and endpoint summary. |
| 4 | `GET /api/invoices` | Validates query parameters, then lists invoices. |
| 5 | `POST /api/invoices` | Applies the invoice body limit, validates the invoice payload, then returns the create placeholder. |
| 6 | `GET /api/escrow/:invoiceId` | Resolves escrow address mapping, reads escrow state, and adds `X-Escrow-Address`. |
| 7 | `GET /error`, `GET /debug/error`, `GET /prod-error` | Test/debug routes that deliberately enter the error pipeline. |

## Feature router mounts

Feature routers are mounted through `mountFeatureRouter()`, then
`assertNoDuplicateRouterMounts()` runs before metrics and catch-all handlers.
The assertion prevents the same router instance from being mounted twice at the
same base path. Multiple routers may intentionally share a base path when they
are distinct instances.

| Order | Base path | Router module | Important local ordering |
|-------|-----------|---------------|--------------------------|
| 1 | `/api/sme` | `routes/sme` | `routes/sme/index.js` mounts SME metrics first, then invoice upload helpers. Individual SME invoice routes apply `extractTenant`; the presigned-url route also applies `idempotencyMiddleware`. |
| 2 | `/api/invoices` | `routes/invoiceFile` | File upload and presigned URL handlers for invoice files. |
| 3 | `/api/invoices` | `routes/invoiceStateRoutes` | Invoice state-machine routes. This is a second, distinct router sharing the invoice base path. |
| 4 | `/api/invest` | `routes/invest` | Starts with `authenticatedTenantStack` (`authenticateToken` -> `extractTenant`). `POST /fund-invoice` then runs `requireKycForFunding`, `idempotencyMiddleware`, body validation, an inline `legalHoldGate()` call, escrow address resolution, Soroban submission, and commitment persistence. |
| 5 | `/api/investor` | `routes/investor` | Mounted exactly once. Lock list/detail handlers run `authenticateToken` -> `extractTenant` before cache and handler logic. |
| 6 | `/api/kyc` | `routes/kyc` | KYC webhook and verification routes. The raw body parser for `/api/kyc/webhook` has already run globally before JSON parsing. |
| 7 | `/api/marketplace` | `routes/marketplace` | Starts with `authenticatedTenantStack`, then `GET /` runs marketplace cache middleware before query validation and service lookup. |
| 8 | `/api/retention` | `routes/retention` | Uses a local `adminAuth` helper that accepts either API key auth or JWT auth. Sensitive mutation routes add `sensitiveLimiter` after admin auth. |
| 9 | `/api/admin/audit` | `routes/auditTrail` | Audit trail reads apply `authenticateToken` -> `extractTenant` before route logic; the router also has its own error handler. |
| 10 | `/api/admin/escrow` | `routes/adminEscrow` | Starts with `adminStack` (`adminAuth` JWT-or-API-key -> `extractTenant`). |
| 11 | `/api/admin/reconciliation` | `routes/reconciliation` | Starts with `adminStack` before reconciliation route handlers. |
| 12 | `/v1` | `routes/v1` | Versioned API surface. Some routes apply `extractTenant`; `GET /escrow/:invoiceId` applies `authenticateToken` directly. |

## Reusable auth stacks

[`src/middleware/stacks.js`](../src/middleware/stacks.js) defines the shared
ordering used by newer protected routers:

| Stack | Order | Used by |
|-------|-------|---------|
| `authenticatedTenantStack` | `authenticateToken` -> `extractTenant` | `/api/invest`, `/api/marketplace` |
| `adminStack` | `adminAuth` (API key if `x-api-key` exists, otherwise JWT) -> `extractTenant` | `/api/admin/escrow`, `/api/admin/reconciliation` |

The order is load-bearing: authentication must run before `extractTenant` so
tenant context can come from the verified JWT or API key. Routes that do not use
these stacks should be checked individually before assuming tenant context is
available.

## Metrics, 404, and error handlers

After inline routes and feature routers, the app registers the final handlers in
this order:

| Order | Handler | Purpose |
|-------|---------|---------|
| 1 | `GET /metrics` with `metricsAuth` | Prometheus scrape endpoint. It is mounted after feature routers, so an earlier matching route would win. |
| 2 | 404 catch-all | Returns `{ error: 'Not found', path }` for unknown routes. |
| 3 | `handleCorsError` | Converts the dedicated blocked-origin CORS error into a 403 JSON response. Other errors continue down the chain. |
| 4 | `payloadTooLargeHandler` | Converts Express body-parser `entity.too.large` errors into 413 JSON and increments body-size metrics. |
| 5 | `handleInternalError` | Handles bad JSON / 400 parser errors, `AppError`-style 4xx errors, and final 500 responses. Development responses may include stack details; production responses do not. |

This means CORS rejection and payload-size normalization happen before the
generic internal-error handler, while route-local errors that skip those special
cases are ultimately normalized by `handleInternalError` and then by the outer
standard response envelope.
