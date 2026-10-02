# Production readiness

## Runtime and deployment shape

SkillSwap uses a React/Vite frontend and a Node HTTP API backed by SQLite (`node:sqlite`). Use Node.js 22.5 or later. The frontend calls relative `/api` paths, so serve the frontend and proxy `/api` on the same HTTPS origin. The API deliberately does not enable cross-origin resource sharing; the backend also checks unsafe-request `Origin` headers against `FRONTEND_URL` when configured. Do not expose the API directly to the public internet without a trusted HTTPS reverse proxy and request-size/connection limits.

Configure the reverse proxy to serve the built `dist/` directory, forward `/api/` to the API listener, preserve the original `Host`, set `X-Forwarded-Proto` only from the trusted proxy, and serve HTTPS. Set `TRUST_PROXY=true` only when that trusted proxy is in front of the API. Set `API_HOST=127.0.0.1` when proxy and API share a host; use a private container/interface address when they do not. The API defaults to loopback and port 3001. The Vite proxy target is development-only and can be set with `VITE_API_PROXY_TARGET`.

## Environment

Copy `.env.example` to `.env` and set values in the private environment store used by the deployment. `.env` and `.env.*` are ignored by Git; `.env.example` contains variable names with empty values only.

Required in production:

- `NODE_ENV=production`
- `SESSION_SECRET`: at least 32 bytes of cryptographically random material.
- `FRONTEND_URL`: the absolute HTTPS origin used by the browser.
- `API_HOST` and `API_PORT`: bind only to the interface reachable by the reverse proxy.
- `SKILLSWAP_DB_PATH`: an absolute path on persistent local storage, outside the deploy artifact.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `ADMIN_NAME` only for the one-time `npm run seed:admin` operation. Remove the seed password from the runtime environment after seeding.

Payments remain disabled unless `SESSION_PAYMENTS_ENABLED`, the amount/currency, and complete provider credentials are configured. Use provider sandbox credentials until live activation is separately approved. `PAYMENT_KEY_ID` is the checkout provider's public identifier; all other payment secrets remain server-side. `AI_*` settings are optional; deterministic recommendations work without them. Recommendation weights/cache controls are optional. Do not place secrets in variables prefixed with `VITE_`.

The API loads values from environment variables and a private root `.env` file. Environment-provided values take precedence. Production startup rejects an absent or non-HTTPS `FRONTEND_URL` and enables secure session cookies. SameSite Strict and HttpOnly cookies are retained. Change `TRUST_PROXY` only to reflect the actual network topology.

## Database and migrations

The application runs repeatable `CREATE TABLE IF NOT EXISTS`, guarded `ALTER TABLE`, and index migrations during startup. `SKILLSWAP_DB_PATH` is resolved against the project root if relative; prefer an absolute production path. SQLite foreign-key enforcement, a five-second busy timeout, WAL journal mode, and NORMAL synchronous mode are enabled. Keep the database on a durable local filesystem; do not put a live WAL database on a network filesystem or share it between multiple API hosts. Use one API writer unless the database is migrated to a server database in a separately planned change.

Take a verified snapshot before each release that may run migrations. For a live backup, use SQLite's online backup command (`sqlite3 SOURCE.sqlite ".backup BACKUP.sqlite"`) or an equivalent SQLite backup API; do not copy only the main database file while the service is writing in WAL mode. Retain encrypted backups in a separate failure domain. A practical starting policy is daily backups plus a pre-release backup, with retention set to business recovery requirements. Periodically restore a backup to an isolated path, start the application against that copy, and confirm readiness before considering the backup recoverable.

For recovery, stop the API, preserve the failed database and its `-wal`/`-shm` files for investigation, restore the selected verified backup to the configured database path, ensure the service account owns the directory, then start the API and check `/api/ready`. If a migration fails, do not delete or edit production records to force startup; restore the pre-release snapshot and investigate against a copy.

## Security controls

- Passwords use salted scrypt hashes; sessions use random tokens stored as HMAC hashes and expire after seven days.
- Session cookies are HttpOnly, SameSite Strict, and Secure in production. Logout invalidates the session and closes its live event streams.
- Admin APIs check the persisted active role on each request. Resource APIs apply ownership, participant, block, and status checks.
- Unsafe requests with an `Origin` header must match `FRONTEND_URL` (or the same-origin host when it is not configured). No permissive CORS headers are emitted.
- API responses include a generated request ID and security headers. HSTS is sent in production; the HTTPS proxy must also apply the documented headers to static frontend documents. Vite preview includes CSP, frame, content-type, referrer, and permissions headers; production static hosting must configure equivalent response headers.
- Request/error logs are structured and omit request bodies, cookies, user emails, and provider error messages. Never add credentials or personal data to log fields.
- JSON request bodies are limited to 16 KiB, avatar uploads to 5 MiB, and payment webhooks to 1 MiB. Avatar type is checked against content signatures.
- AI inputs are allowlisted and bounded; provider errors fall back to deterministic recommendations. Provider calls have a five-second timeout and per-user limits.
- Payment creation uses server-defined amounts. Verification fetches provider status, webhook signatures are checked, webhook IDs are deduplicated, and refunds are admin-only.
- Realtime messages are authenticated, scoped to the current user/conversation participants, and synchronize from REST after reconnect.

The static frontend security policy permits the app origin, Google Fonts, and Razorpay checkout endpoints used by the current UI. Review and update the CSP whenever an approved external integration changes. Add HSTS and `X-Frame-Options: DENY` (or an equivalent `frame-ancestors` directive) at the HTTPS edge as well as the API.

## Health checks and operation

- `GET /api/health` is a liveness check and returns only `{ "ok": true }`.
- `GET /api/ready` performs a small SQLite query and confirms foreign-key enforcement; it returns `503` with a safe message if unavailable.
- Run `npm run build` during release preparation. Run the API as a long-lived Node process and let the process manager restart unexpected exits. Use SIGTERM for shutdown so the API can stop its reminder timer, close realtime streams, finish HTTP requests, and close SQLite cleanly.
- Keep production secrets in the hosting environment's secret store. Remove `.env` from release artifacts, restrict database/uploads/backups filesystem permissions, enable TLS renewal monitoring, and rotate secrets after suspected exposure.

## Known production limitations

- Password-reset requests are rate-limited but email delivery is not configured. The API now returns `503` instead of claiming reset instructions were sent; configure a verified mail provider before advertising password recovery.
- Avatar files are stored on the API host's local `backend/uploads/avatars` directory. Production needs a persistent protected volume and a backup policy for that directory; horizontally scaled API instances need shared storage in a separately reviewed change.
- SQLite is suitable for a single application writer on durable local storage. Multi-host write scaling requires a database migration and is outside this hardening step.
- The repository does not select a production static host or reverse proxy. Apply equivalent static-document security headers and TLS policy in the chosen hosting configuration.
