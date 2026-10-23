# Sparrow Backend

The Sparrow API: a Node.js and TypeScript service that replaces the earlier Supabase direction. This package is self-contained, with its own `package.json`, lockfile, tooling and CI workflow.

## Stack

| Concern       | Choice                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| Runtime       | Node.js 24 (CI); 22.12 or newer works locally                                      |
| Language      | TypeScript, strict, ESM (`NodeNext`)                                               |
| HTTP          | Express 5                                                                          |
| Database      | PostgreSQL 17, Prisma 7 with the `pg` driver adapter                               |
| Validation    | Zod                                                                                |
| Logging       | Pino, pino-http                                                                    |
| Auth          | Firebase Phone Auth, then HS256 access tokens (`jose`) and rotating refresh tokens |
| Abuse control | express-rate-limit, helmet, CORS allowlist                                         |
| Tests         | Vitest, Supertest                                                                  |

## Local setup

Prerequisites: Node.js 22.12 or newer, npm, and Docker Desktop (WSL 2 backend on Windows).

PowerShell:

```powershell
cd backend
Copy-Item .env.example .env
# Set JWT_ACCESS_SECRET in .env to the output of:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

docker compose up -d --wait   # PostgreSQL 17 on 127.0.0.1:5433
npm ci                        # also generates the Prisma client
npm run db:migrate            # applies all migrations
npm run dev                   # http://localhost:4000, restarts on change
```

Check it is up:

```powershell
Invoke-RestMethod http://localhost:4000/health/ready
```

On macOS or Linux, use `cp .env.example .env` and `curl` instead.

If port 5433 is already in use, set `POSTGRES_PORT` in `.env` to a free port and use the same port in `DATABASE_URL` and `TEST_DATABASE_URL`.

## Scripts

| Script                              | Purpose                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `dev`                               | Run the API with reload, loading `.env` if present                                       |
| `build` / `start`                   | Compile to `dist/` and run the compiled server                                           |
| `typecheck`, `lint`, `format:check` | Static checks run in CI                                                                  |
| `test`                              | Unit and integration tests (Docker database must be running)                             |
| `test:unit`                         | Unit tests only, no database needed                                                      |
| `test:integration`                  | Integration tests against `TEST_DATABASE_URL`                                            |
| `test:coverage`                     | All tests with coverage; fails below 80% of lines                                        |
| `db:migrate`                        | Apply pending migrations (`prisma migrate deploy`)                                       |
| `db:migrate:dev`                    | Create and apply a new migration during development                                      |
| `db:reset`                          | Drop and recreate the database from migrations. Local only, destroys data                |
| `db:check-drift`                    | Fail if `schema.prisma` differs from the migrated database                               |
| `db:generate`                       | Regenerate the Prisma client (also runs on install)                                      |
| `token:dev`                         | Open a local session and print its tokens, see [Development tokens](#development-tokens) |

## Environment variables

All variables are validated at startup by `src/config/env.ts`. On invalid configuration the server exits and prints the failing variable names, never their values. See `.env.example` for the documented defaults.

| Variable                                                             | Required     | Default                                 | Notes                                                                                                 |
| -------------------------------------------------------------------- | ------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                           | Yes          | none                                    | `development`, `test` or `production`                                                                 |
| `PORT`                                                               | No           | `4000`                                  |                                                                                                       |
| `LOG_LEVEL`                                                          | No           | `info`                                  | Pino level                                                                                            |
| `DATABASE_URL`                                                       | Yes          | none                                    | `postgresql://` URL                                                                                   |
| `JWT_ACCESS_SECRET`                                                  | Yes          | none                                    | At least 32 characters                                                                                |
| `JWT_ISSUER`                                                         | No           | `sparrow-api`                           |                                                                                                       |
| `JWT_AUDIENCE`                                                       | No           | `sparrow-app`                           |                                                                                                       |
| `CORS_ORIGINS`                                                       | No           | empty                                   | Comma-separated origins; must be https in production                                                  |
| `TRUST_PROXY`                                                        | No           | `0`                                     | Proxy hops in front of the API; `1` on Render                                                         |
| `RATE_LIMIT_WINDOW_MS`                                               | No           | `60000`                                 |                                                                                                       |
| `RATE_LIMIT_MAX`                                                     | No           | `100`                                   | Requests per window per client IP on `/api`                                                           |
| `FIREBASE_SERVICE_ACCOUNT_BASE64`                                    | Production   | empty                                   | Base64 of the service account JSON key file; without it, sign-in returns 503                          |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                                      | No           | `900`                                   | 60 to 3600                                                                                            |
| `AUTH_REFRESH_TOKEN_TTL_DAYS`                                        | No           | `30`                                    | Idle timeout; must not exceed the session max age                                                     |
| `AUTH_SESSION_MAX_AGE_DAYS`                                          | No           | `90`                                    | Absolute session lifetime, then a new OTP                                                             |
| `AUTH_FIREBASE_MAX_AUTH_AGE_SECONDS`                                 | No           | `300`                                   | How recent the OTP sign-in must be to exchange it                                                     |
| `AUTH_REFRESH_REUSE_GRACE_SECONDS`                                   | No           | `30`                                    | 0 to 300; a replay of the previous refresh token this soon after rotation is refused without revoking |
| `AUTH_EXCHANGE_RATE_LIMIT_WINDOW_MS`, `AUTH_EXCHANGE_RATE_LIMIT_MAX` | No           | `900000`, `30`                          | Per-IP limit on `POST /auth/firebase`                                                                 |
| `AUTH_REFRESH_RATE_LIMIT_WINDOW_MS`, `AUTH_REFRESH_RATE_LIMIT_MAX`   | No           | `900000`, `30`                          | Per-IP limit shared by refresh and logout                                                             |
| `TEST_DATABASE_URL`                                                  | Tests only   | `...5433/sparrow_test`                  | Name must end in `_test`                                                                              |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Compose only | `sparrow`, `sparrow`, `sparrow`, `5433` | Local database container                                                                              |

## Project structure

```
src/
  server.ts        Composition root: config, logger, Prisma, app, listen, shutdown
  app.ts           createApp(deps): builds the Express app from injected dependencies
  config/          Environment validation
  lib/             Logger and Prisma client factories
  http/            Errors, response envelope, middleware, server timeouts
  api/v1/          v1 router and the list of feature modules it serves
  modules/<name>/  Feature modules: routes, controller, service, repository
  types/           Shared types (roles, auth context)
  generated/       Prisma client, generated, not committed
prisma/            schema.prisma and migrations
scripts/           Developer scripts
tests/             unit/, integration/, helpers/, setup/
```

### Module boundaries

- Only repositories use Prisma.
- Services contain business logic and never import Express types.
- Controllers stay thin: take validated input, call a service, send the envelope.
- A module uses another module only through its exported service or repository.
- `http/`, `lib/` and `config/` never import from `modules/`. Where the HTTP layer needs data, it declares a small interface that a module implements, as `authenticate` does with `AuthSubjectLookup`.

## API conventions

### Versioning

Client endpoints live under `/api/v1`. Additive changes stay in v1. A breaking change gets a new `/api/v2` router mounted alongside v1 until clients have migrated. Health endpoints are operational and unversioned.

A feature module registers itself in `src/api/v1/modules.ts`:

```ts
export const v1Modules: readonly V1Module[] = [deliveriesModule];
```

### Response envelope

Success:

```json
{
  "data": { "id": "0b6c...", "status": "requested" },
  "meta": { "nextCursor": "..." }
}
```

`meta` is present only when there is something to put in it. Use `sendData(res, data, { status, meta })`.

Error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "body.phone", "message": "Invalid input" }],
    "requestId": "7f3c2a1e-..."
  }
}
```

`details` appears on validation errors only. Every response carries an `X-Request-Id` header that matches the `requestId` in logs and error bodies.

| Status | Code                  | When                                                    |
| ------ | --------------------- | ------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`    | Params, query or body failed schema validation          |
| 400    | `INVALID_JSON`        | Malformed JSON body                                     |
| 400    | `BAD_REQUEST`         | Other malformed requests                                |
| 401    | `UNAUTHENTICATED`     | Missing, invalid or expired token, or revoked session   |
| 403    | `FORBIDDEN`           | Authenticated but not allowed                           |
| 403    | `ACCOUNT_SUSPENDED`   | User is suspended                                       |
| 403    | `PHONE_NOT_SUPPORTED` | Sign-in with a number that is not a Nigerian mobile     |
| 404    | `NOT_FOUND`           | Unknown route or resource                               |
| 409    | `CONFLICT`            | Uniqueness or state conflict                            |
| 413    | `PAYLOAD_TOO_LARGE`   | JSON body over 100 kB                                   |
| 429    | `RATE_LIMITED`        | Rate limit exceeded; see `Retry-After`                  |
| 503    | `SERVICE_UNAVAILABLE` | A dependency is down (readiness, Firebase)              |
| 500    | `INTERNAL_ERROR`      | Anything unexpected; details are logged, never returned |

Throw the typed errors from `src/http/errors.ts`. Anything else becomes a generic 500.

### Validation

Validate every input at the boundary with `validate({ params, query, body })`. Handlers receive the parsed output. Use `z.strictObject` for bodies so unknown fields, such as a client-sent price or role, are rejected rather than ignored.

## Health checks

| Endpoint            | Behaviour                                                     |
| ------------------- | ------------------------------------------------------------- |
| `GET /health/live`  | 200 while the process is running. Never touches dependencies. |
| `GET /health/ready` | 200 when PostgreSQL answers within 2 s, otherwise 503.        |

Health responses are not cached, not logged and not rate limited.

## Authentication and authorization

### Phone sign-in

Customers sign in with a phone OTP through Firebase Phone Authentication. Firebase sends and checks the code on the device. The API never sees the OTP. It verifies the resulting Firebase ID token and issues its own session tokens.

```
App                         Firebase              Sparrow API
 | signInWithPhoneNumber  ->  |                       |
 | confirm(code)          ->  |                       |
 | getIdToken()           <-  |                       |
 | POST /api/v1/auth/firebase { idToken } --------->  | verify, upsert user, open session
 | <-------------------------------- { user, isNewUser, tokens }
```

The exchange accepts a token only when all of the following hold:

| Check                                                       | Enforced by                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| Signature, issuer, audience, expiry                         | Admin SDK `verifyIdToken`                                      |
| Not revoked, Firebase user not disabled                     | Admin SDK, with `checkRevoked`                                 |
| `sign_in_provider` is `phone` and `phone_number` is present | API                                                            |
| `auth_time` within `AUTH_FIREBASE_MAX_AUTH_AGE_SECONDS`     | API                                                            |
| Number is a Nigerian mobile (`+234` 70, 80, 81, 90, 91)     | API, else 403 `PHONE_NOT_SUPPORTED`                            |
| Sign-in not exchanged before                                | Unique `(firebase_uid, firebase_auth_time)` on `auth_sessions` |

New users are created as `customer`. A role is never read from the client.

Firebase failures map to 503, with one exception: when the Admin SDK cannot fetch Google's public signing keys, it reports the failure as an invalid token, so the exchange returns 401. The SDK caches the keys, so this only shows up on a cold start or a key rotation during a Google outage.

### Endpoints

All three are public and sit under `/api/v1/auth`. Token responses send `Cache-Control: no-store`.

| Method and path       | Body               | Success                                                          | Failure                                                                                                                                                                             |
| --------------------- | ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/firebase` | `{ idToken }`      | 200 `{ data: { user: { id, phone, role }, isNewUser, tokens } }` | 401 rejected, stale or already exchanged token; 403 `ACCOUNT_SUSPENDED` or `PHONE_NOT_SUPPORTED`; 503 Firebase unavailable or not configured (a failed key fetch is 401, see above) |
| `POST /auth/refresh`  | `{ refreshToken }` | 200 `{ data: { tokens } }` with a new pair                       | 401 for any invalid, expired, revoked or reused token; 403 `ACCOUNT_SUSPENDED`                                                                                                      |
| `POST /auth/logout`   | `{ refreshToken }` | 204, whether or not the token was valid                          | 400 for a malformed body only                                                                                                                                                       |

`tokens` is `{ tokenType: "Bearer", accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`, with ISO 8601 timestamps.

### Sessions and tokens

- **Access token.** An HS256 JWT pinned to `JWT_ISSUER`, `JWT_AUDIENCE` and the `at+jwt` type. It must carry `sub`, `sid` (the session id), `exp` and `iat`, and lives for `AUTH_ACCESS_TOKEN_TTL_SECONDS`.
- **Refresh token.** `<session id>.<43 base64url characters>`. Only a SHA-256 hash of the random part is stored, in `auth_sessions`.
- **Rotation.** Every refresh swaps the stored hash in one conditional update and returns a new pair. The old refresh token stops working; its hash is kept as the session's previous hash.
- **Reuse detection.** Only the previous refresh token counts as reuse. Presented more than `AUTH_REFRESH_REUSE_GRACE_SECONDS` after the rotation, it revokes the whole session (`refresh_reuse`) and logs a warning carrying the session and user ids as structured fields. Inside the window it is most likely the client's own parallel refresh, so it gets 401 without revoking. Any other secret, including a random one for a valid session id, gets 401 and changes nothing, so knowing a session id is not enough to end a session.
- **Expiry.** The refresh token expires after `AUTH_REFRESH_TOKEN_TTL_DAYS` without use. The session ends `AUTH_SESSION_MAX_AGE_DAYS` after sign-in, whatever the activity, and the user signs in with a new OTP.
- **Logout.** Revokes the session that owns the refresh token.

### Protecting routes

Clients send `Authorization: Bearer <access token>`. Every verification failure returns the same 401.

The token proves identity only. On every request, `authenticate` loads the user's role and status through the token's session in one query. A role change, suspension, logout or reuse revocation therefore takes effect on the next request.

Protecting a route inside a module:

```ts
export const ridersModule: V1Module = {
  path: '/riders',
  createRouter({ authenticate, requireRole }) {
    const router = Router();
    router.get(
      '/',
      authenticate,
      requireRole('admin'),
      validate({ query: listRidersQuery }),
      controller.list,
    );
    return router;
  },
};
```

`requireRole` is a coarse role gate. Ownership checks, such as a customer reading only their own deliveries, belong in services. Mounting `requireRole` without `authenticate` fails closed with a 500.

### Firebase configuration

1. In the Firebase console, create a service account key (Project settings, Service accounts).
2. Encode it on one line. Do not commit the JSON file; `*service-account*.json` and `firebase-adminsdk-*.json` are git-ignored.

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\key.json"))
   ```

3. Set the result as `FIREBASE_SERVICE_ACCOUNT_BASE64`.

The variable is required in production; the server exits at startup without it. Outside production it is optional, and `POST /auth/firebase` returns 503 until it is set. The server also refuses to start when `FIREBASE_AUTH_EMULATOR_HOST` is set, because the Admin SDK skips signature checks in emulator mode.

### Firebase console launch checklist

Firebase, not this API, enforces the OTP itself: code expiry, single use, resend cooldown and per-number SMS limits. Before launch, confirm in the console:

- [ ] Phone sign-in provider enabled.
- [ ] SMS region policy set to allow Nigeria only.
- [ ] App Check enforced for Authentication (Play Integrity on Android, App Attest or DeviceCheck on iOS).
- [ ] SMS quota and abuse alerts reviewed.
- [ ] Test phone numbers removed, or kept only in non-production projects.
- [ ] Production service account stored only in the hosting platform's secret settings.

### Frontend integration notes

- **Development build.** `@react-native-firebase/app` and `@react-native-firebase/auth` need an Expo development build; Expo Go cannot run phone auth. `google-services.json` and `GoogleService-Info.plist` are client configuration, not secrets.
- **Flow.**
  1. `signInWithPhoneNumber('+234...')`.
  2. `confirm(code)`.
  3. `getIdToken()`.
  4. `POST /api/v1/auth/firebase` with the ID token, within five minutes of step 2.
  5. `signOut()` from Firebase. From here on, only Sparrow tokens are used.
- **Storage.** Keep the refresh token in `expo-secure-store` and the access token in memory. Never use AsyncStorage for either.
- **Refresh.** On a 401 from an API call, refresh once and retry. Allow only one refresh at a time: of two parallel refreshes with the same token, one gets the new pair and the other gets 401. Keep the pair that succeeded and drop the 401. Replaying an old refresh token after the grace window revokes the session.
- **Known limitation: a lost `/refresh` response still requires a new sign-in.** Only a hash of the new refresh token is stored, so the server cannot resend it. If the response never reaches the app, retrying with the old token returns 401 and the user must sign in again with a new OTP.
- **Logout.** Call `POST /auth/logout` with the refresh token, then clear secure storage.
- **Error codes to handle.** `PHONE_NOT_SUPPORTED`, `ACCOUNT_SUSPENDED`, `RATE_LIMITED` (honour `Retry-After`) and `SERVICE_UNAVAILABLE`.

### Development tokens

```powershell
npm run token:dev -- --phone +2348012345678 --role admin
```

The script creates the user or reuses it by phone, sets the requested role, and opens a session without Firebase. The phone accepts the same formats as sign-in (`+234...`, `234...` or `0...`). It prints one JSON line on stdout with the same shape as `tokens` above; the access token is valid for one hour. It refuses to run unless `NODE_ENV` is `development` and `DATABASE_URL` points at localhost.

To try refresh and logout without a phone, capture the tokens and call the endpoints:

```powershell
$t = npm run --silent token:dev -- --phone 08012345678 --role customer | ConvertFrom-Json
$body = @{ refreshToken = $t.refreshToken } | ConvertTo-Json
Invoke-RestMethod -Method Post http://localhost:4000/api/v1/auth/refresh -ContentType 'application/json' -Body $body
```

## Rate limiting and hardening

- **Default limit.** Every `/api` route is limited to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client IP. Responses carry standard `RateLimit` and `RateLimit-Policy` headers.
- **Sensitive routes.** Add a stricter limiter with `createRateLimiter({ windowMs, max, keyGenerator })`, keyed on something an attacker cannot rotate cheaply, such as phone number plus IP.
- **Auth routes.** `POST /auth/firebase` has its own per-IP limit, and refresh and logout share another (see `AUTH_*_RATE_LIMIT_*`). The phone number is unknown until the ID token is verified, so per-number limits are left to Firebase. Nigerian carriers put many users behind one IP (CGNAT), so watch these limits after launch.
- **Client IP behind a proxy.** Client IPs come from `req.ip`, which honours `TRUST_PROXY`. Set it to the exact number of proxies in front of the API. Too low makes all clients share one limit; too high lets clients spoof `X-Forwarded-For`.
- **Single instance only.** The limiter store is in memory and is correct only for one instance. Running more than one needs a shared Redis store.
- **Other hardening.**
  - helmet security headers.
  - CORS restricted to `CORS_ORIGINS`, with credentials disabled.
  - JSON bodies up to 100 kB.
  - Server timeouts: 20 s for headers, 30 s for a full request.

## Logging

- **Format.** Structured JSON via Pino, pretty-printed in development.
- **Access log.** One line per request with method, path (no query string), status, response time and request id.
- **Never logged:** headers, query strings and bodies.
- **Redaction.** Known sensitive keys (`authorization`, `password`, `secret`, `token`, `accessToken`, `refreshToken`, `otp`, `pin`) are redacted at the top level and one level deep. Log chosen fields rather than whole nested objects.

## Database and migrations

- **Source of truth.** `prisma/schema.prisma` plus the committed SQL in `prisma/migrations/`.
- **Making a change.**
  1. Edit the schema.
  2. Run `npm run db:migrate:dev -- --name <change>`.
  3. Review the generated SQL.
  4. Commit both.
- **Applied migrations are never edited.** Fix forward with a new migration.
- **Hand-written SQL.** Rules Prisma cannot express, such as CHECK constraints and partial indexes, are added to the migration SQL by hand. Example: the E.164 phone check on `users`.
- **Deployment.** Deployments and CI only run `prisma migrate deploy`.
- **Drift check.** `db:check-drift` compares a migrated database with the schema. CI runs it on a fresh database.
- **Conventions.** Tables and columns use snake_case through `@@map` and `@map`. Ids are UUIDs generated by the database.

## Testing

- **Unit tests** (`tests/unit`) need no database. Apps are built with `createApp` and fake dependencies.
- **Integration tests** (`tests/integration`) run against `TEST_DATABASE_URL`.
  - Global setup applies pending migrations with `migrate deploy`.
  - Each test truncates all tables.
  - Setup refuses any database whose name does not end in `_test`.
- **Test database.** Docker compose creates `sparrow_test` the first time the volume is initialised. If your volume predates that, create it once with:

  ```powershell
  docker compose exec postgres psql -U sparrow -d sparrow -c "CREATE DATABASE sparrow_test;"
  ```

- **Coverage.** Must stay at or above 80% of lines.

## Continuous integration

`.github/workflows/backend-ci.yml` runs on pull requests and pushes to `main` that touch `backend/`.

- **Database.** A PostgreSQL 17 service with an empty database.
- **Steps, in order:**
  1. Install.
  2. Format check, lint and typecheck.
  3. Apply all migrations from scratch.
  4. Drift check.
  5. Tests with coverage.
  6. Build.
