# SkillSwap

## Local administrator setup

The initial administrator is created only by the server-side seed command. There is no public administrator registration page.

1. Copy `.env.example` to `.env` (the `.env` file is ignored by Git).
2. Set `ADMIN_PASSWORD` to a strong private password and `SESSION_SECRET` to a random value of at least 32 bytes. Keep both values in `.env`; do not paste them into source files or commit them.
3. Run `npm run seed:admin` once to create or refresh the configured administrator account.
4. Start the API with `npm run dev:server` and the frontend with `npm run dev`.
5. Open `/admin/login` to sign in.

The API uses the Node built-in SQLite database at `backend/data/skillswap.sqlite`. Passwords are stored as salted `scrypt` hashes. Administrator APIs read the active role from the database for every request.

For production environment, database backup/recovery, security headers, health checks, deployment topology, and known operational limitations, see [Production readiness](docs/PRODUCTION.md). Production must use Node.js 22.5 or later, HTTPS, a persistent SQLite path, and a same-origin reverse proxy for `/api`.

## Payments (Step 13)

Payments use a provider adapter so session/payment business rules remain independent of checkout-provider details. The included adapter uses the Razorpay Orders and Payments APIs. It does not store card numbers, CVVs, or bank credentials.

### Configuration

Copy the payment variables from `.env.example` into the private `.env` and configure them only on the server:

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PROVIDER` | Set to `razorpay` to enable the included adapter. |
| `PAYMENT_KEY_ID` | Razorpay key ID; the server returns this public identifier only for checkout. |
| `PAYMENT_KEY_SECRET` | Server-only provider API and checkout-signature secret. |
| `PAYMENT_WEBHOOK_SECRET` | Server-only webhook-signature secret configured for the provider webhook. |
| `PAYMENT_CURRENCY` | Three-letter currency, default `INR`. |
| `SESSION_PAYMENTS_ENABLED` | Must be explicitly set to `true` before a session can require payment. |
| `SESSION_PAYMENT_AMOUNT_MINOR` | Server-controlled amount in the currency's smallest unit (for example, paise for INR). Set a reviewed price; never accept an amount from a browser request. |

Payments remain disabled until a provider, test credentials, and a server-side amount are configured. Start with provider test-mode credentials and verify webhook delivery before changing to live keys. Do not commit `.env` or production credentials.

### API

All endpoints below use the existing HTTP-only session cookie unless specified. The browser cannot choose the amount, currency, owner, or payment status.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/payments/create` | Signed-in session participant | Body: `{ "sessionId": "…" }`. Creates a server-priced provider order for a confirmed session on an active exchange. Returns a payment record and minimal checkout data (`provider`, public `keyId`, provider `orderId`, amount, currency, description). |
| `POST /api/payments/verify` | Payment owner | Body: `{ "paymentId": "…", "providerPaymentId": "…", "providerOrderId": "…", "signature": "…" }`. The server checks the provider signature and fetches the payment to confirm order, amount, currency, and captured status before marking it successful. |
| `POST /api/payments/webhook` | Provider signature | Raw request body must have valid `X-Razorpay-Signature` and unique `X-Razorpay-Event-Id` headers. Captured, failed, and processed-refund events are recorded idempotently. Configure `payment.captured`, `payment.failed`, and `refund.processed` events at the provider. |
| `GET /api/payments?status=ALL` | Signed-in user | Returns only the caller's newest 100 records. Filters: `ALL`, `SUCCESS`, `PENDING`, `FAILED`, `REFUNDED` (`PENDING` includes `CREATED`). |
| `GET /api/payments/:id` | Owner (or administrator) | Returns one safe payment record; other users receive not found. |
| `POST /api/payments/:id/refund` | Administrator | Initiates a full refund only for a successful payment. Provider-pending refunds remain pending until the signed `refund.processed` webhook arrives. |

Payment statuses are `CREATED`, `PENDING`, `SUCCESS`, `FAILED`, `CANCELLED`, and `REFUNDED`. A browser checkout callback alone never marks a payment successful. Provider events are signature-checked, amount/currency-matched, and deduplicated by event ID. Payment changes create `PAYMENT_SUCCESS`, `PAYMENT_FAILED`, or `PAYMENT_REFUNDED` entries in the existing notification system. The account dashboard includes recent payments and links to `/payments`.

Razorpay's documented flow creates an order server-side, verifies checkout signatures using the trusted server order ID, checks payment capture, and verifies webhooks with HMAC. See the official [Razorpay integration guide](https://razorpay.com/docs/payments/payment-gateway/capacitor-integration/test-integration//?preferred-country=IN) and [security checklist](https://razorpay.com/security/checklist).

### Payment tests

Run `npm test` to exercise amount integrity, participant authorization, duplicate order prevention, verification outcomes, webhook deduplication, notification creation, refunds, and the Razorpay adapter with local fake provider responses.

## Admin management and moderation (Step 14)

The existing administrator session and database role protect every `/api/admin/*` endpoint. Admin routes are `/admin/dashboard`, `/admin/users`, `/admin/users/:userId`, `/admin/skills`, `/admin/swaps`, `/admin/swaps/:swapRequestId`, `/admin/reports`, `/admin/reports/:reportId`, `/admin/payments`, `/admin/audit-logs`, and `/admin/settings`. A normal user receives `403` from admin APIs; guests receive `401`.

The dashboard uses database counts for users, skills, swaps, sessions, payments, and reports. User and swap lists support search, filters, sorting, pagination, and read-only details. Administrator account suspension requires a reason, stores the administrator and timestamp, retains user data, notifies the account, and blocks authenticated activity with `403` and the message `Your account is currently suspended. Please contact support.` Reactivation restores access. Administrator accounts cannot be suspended through this interface.

Skills can be created, edited, searched, filtered, activated, and deactivated. Deactivation preserves skill and profile relationships and removes the skill from new discovery and matching results. Users can submit authenticated reports against another profile, an exchange they participate in, or a message in their conversation. Reports are rate limited and duplicate open reports are rejected. Administrators can review, resolve, or dismiss reports with an internal note; only the reporter is notified that a review occurred.

Admin payment records are read-only and omit card data and provider secrets. Platform settings are read-only and expose only the platform name, support email, default currency, and maintenance-mode indicator; secret environment configuration is never returned. The append-only audit API `GET /api/admin/audit-logs` supports pagination and action, target type, administrator, and date filters. It records account, skill, and report moderation actions without authentication credentials or payment secrets.

Relevant endpoints include `GET /api/admin/dashboard`, paginated `GET /api/admin/users|skills|swaps|reports|payments`, `GET /api/admin/users/:id`, `GET /api/admin/swaps/:id`, `GET /api/admin/reports/:id`, user suspend/activate actions, skill create/update/activate/deactivate actions, report creation at `POST /api/reports`, report review/resolve/dismiss actions, and audit logs. All administrative mutations use the server's active database role check; user IDs, roles, prices, and moderation state supplied by a browser are not trusted. Run `npm test` for the admin integration and payment service tests.

## Step 15 — trust, safety, and platform quality

User safety settings are available at `/settings/privacy`, `/settings/security`, `/settings/blocked-users`, `/settings/account`, and `/safety`. The profile visibility values keep `PRIVATE` profiles out of public discovery; email is returned only when the member opts in. Availability and review endpoints also respect their visibility switches. Match and discovery results exclude blocked relationships and display a verification badge only for the server-assigned `VERIFIED` status. Verification changes are admin-only and create `USER_VERIFIED` / `USER_UNVERIFIED` audit records; this is a profile review marker, not identity verification.

Blocking uses `POST /api/blocks/:userId`, `DELETE /api/blocks/:userId`, `GET /api/blocks`, and `GET /api/blocks/:userId/status`. Existing records are retained. New direct conversations, messages, exchange requests, and session proposals/responses are rejected when either member has blocked the other. Report submission reuses `POST /api/reports`, accepts the supported moderation reasons, limits a member to five reports per hour, and rejects recent duplicates.

Privacy is read and updated at `GET/PATCH /api/settings/privacy`. Account security includes `POST /api/account/password`, `POST /api/account/logout-all`, and `GET /api/account/security`; passwords remain scrypt-hashed, password changes invalidate other sessions, and session tokens are never returned. Sign-in attempts are throttled by address and account key. Password-reset requests return a generic response to avoid confirming whether an account exists.

The data export is generated on request at `POST /api/account/export` and omits credentials, session tokens, provider secrets, and card data. `POST/GET/DELETE /api/account/deletion-request` records/cancels a pending request rather than hard-deleting related records. Payment provider amount and status continue to be set and verified server-side. The `/safety` page gives concise communication, session, reporting, blocking, and payment guidance. Admin dashboard safety totals are live database counts, and user detail includes report/block counts and moderation history.

## Step 16 — AI-assisted matching and recommendations

The existing deterministic matching and discovery functions remain the source of eligible people and skills. `backend/services/recommendations/recommendation.service.mjs` combines their results with skill categories, learning-goal keyword relevance, overlapping weekly availability when both profiles permit sharing it, categories represented in completed swap history, prior successful exchanges with a candidate, pending interactions, visible review summaries, verification status, and profile/skill data. The existing match score remains available as `matchScore`; recommendation scoring defaults to 65% of that score plus 20 points for a direct skill overlap (15 for a complementary teaching/learning overlap, otherwise 10), 5 points when public reviews exist, and 5 points for overlapping availability, capped at 100. Skill suggestions use goal-term overlap, shared skill category, and categories from successful swap history, along with the number of eligible active teachers. Numeric weights are configurable with the `RECOMMENDATION_*` settings in `.env.example`. AI can add a bounded skill-ranking boost (12 points maximum by default) to the deterministic skill score, while the deterministic score remains the majority signal. These signals rank suggestions; they do not guarantee a successful exchange.

The optional provider is isolated in `requestSemanticSkillOrder`. Learning-goal text is processed locally; the provider receives only matched catalog skill/category labels and an allowlisted set of active skill IDs, names, and categories. It can add a bounded ranking signal to these IDs only; the service rejects unknown or duplicate IDs and constructs the user-visible explanation from database facts. No raw goal text, name, email, location, profile biography, messages, credentials, payments, roles, or moderation information are sent. Provider configuration is server-side in `.env` (`AI_PROVIDER=openai` or `openai-compatible`, `AI_API_KEY`, optional `AI_MODEL` and `AI_BASE_URL`). Leave the provider unset for deterministic operation. Do not place API keys in frontend configuration or source control.

Recommendation results are cached per account and recommendation type for `RECOMMENDATION_CACHE_MINUTES` (default 30; bounded to one day). Changes to the member's skills, learning goals, completed swap count, or availability settings produce a new cache key; feedback clears that member's cache. Cached people and skill IDs are rechecked against current active status, profile visibility, and reciprocal blocks before returning results, and availability explanations are recalculated against current privacy settings. Recommendation GET and feedback requests are capped at 30 requests per member per minute; optional provider requests are capped at five per member per hour per server process. Timeouts, missing configuration, provider errors, and invalid provider output use deterministic ranking. Provider health event counts are retained as small aggregate event records and shown on the admin dashboard for the last 30 days.

All endpoints require an active signed-in member session; administrator accounts receive `403` for member recommendation endpoints, and guests receive `401`:

| Method and path | Purpose |
| --- | --- |
| `GET /api/recommendations/users?limit=4` | Ranked people who teach a wanted skill or want to learn a skill the caller teaches. |
| `GET /api/recommendations/skills?limit=4` | Optional catalog skills based on goals, existing skill categories, and active eligible teachers. |
| `GET /api/recommendations/learning-path?limit=3` | Optional ordered suggestions drawn from existing catalog skills; never a required or authoritative course plan. |
| `POST /api/recommendations/feedback` | Body: `{ "targetType": "USER"|"SKILL", "targetId": "…", "feedback": "INTERESTED"|"NOT_INTERESTED" }`. Repeated feedback updates the existing record. |

`/dashboard`, `/find-skills`, and `/matches` share the recommendation cards and explanation UI. The admin dashboard adds 30-day counts for AI recommendation requests/failures, deterministic fallback uses, and cache hits. Recommendation endpoints do not return provider errors, prompts, or keys. The provider adapter tests cover sanitized inputs, allowlist validation, malformed output, missing configuration, and provider failures; the integration suite covers authorization, matching and skill results, explanations, feedback upserts, cache use, live privacy/block/suspension filtering, and request limiting.
