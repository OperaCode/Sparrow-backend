# Sparrow Backend

The Sparrow API: a Node.js and TypeScript service that replaces the earlier Supabase direction. This package is self-contained, with its own `package.json`, lockfile, tooling and CI workflow.

## Stack

| Concern       | Choice                                               |
| ------------- | ---------------------------------------------------- |
| Runtime       | Node.js 24 (CI); 22.12 or newer works locally        |
| Language      | TypeScript, strict, ESM (`NodeNext`)                 |
| HTTP          | Express 5                                            |
| Database      | PostgreSQL 17, Prisma 7 with the `pg` driver adapter |
| Validation    | Zod                                                  |
| Logging       | Pino, pino-http                                      |
| Auth          | HS256 access tokens verified with `jose`             |
| Abuse control | express-rate-limit, helmet, CORS allowlist           |
| Tests         | Vitest, Supertest                                    |

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

| Script                              | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `dev`                               | Run the API with reload, loading `.env` if present                        |
| `build` / `start`                   | Compile to `dist/` and run the compiled server                            |
| `typecheck`, `lint`, `format:check` | Static checks run in CI                                                   |
| `test`                              | Unit and integration tests (Docker database must be running)              |
| `test:unit`                         | Unit tests only, no database needed                                       |
| `test:integration`                  | Integration tests against `TEST_DATABASE_URL`                             |
| `test:coverage`                     | All tests with coverage; fails below 80% of lines                         |
| `db:migrate`                        | Apply pending migrations (`prisma migrate deploy`)                        |
| `db:migrate:dev`                    | Create and apply a new migration during development                       |
| `db:reset`                          | Drop and recreate the database from migrations. Local only, destroys data |
| `db:check-drift`                    | Fail if `schema.prisma` differs from the migrated database                |
| `db:generate`                       | Regenerate the Prisma client (also runs on install)                       |
| `token:dev`                         | Issue a local access token, see [Development tokens](#development-tokens) |

## Environment variables

All variables are validated at startup by `src/config/env.ts`. On invalid configuration the server exits and prints the failing variable names, never their values. See `.env.example` for the documented defaults.

| Variable                                                             | Required     | Default                                 | Notes                                                |
| -------------------------------------------------------------------- | ------------ | --------------------------------------- | ---------------------------------------------------- |
| `NODE_ENV`                                                           | Yes          | none                                    | `development`, `test` or `production`                |
| `PORT`                                                               | No           | `4000`                                  |                                                      |
| `LOG_LEVEL`                                                          | No           | `info`                                  | Pino level                                           |
| `DATABASE_URL`                                                       | Yes          | none                                    | `postgresql://` URL                                  |
| `JWT_ACCESS_SECRET`                                                  | Yes          | none                                    | At least 32 characters                               |
| `JWT_ISSUER`                                                         | No           | `sparrow-api`                           |                                                      |
| `JWT_AUDIENCE`                                                       | No           | `sparrow-app`                           |                                                      |
| `CORS_ORIGINS`                                                       | No           | empty                                   | Comma-separated origins; must be https in production |
| `TRUST_PROXY`                                                        | No           | `0`                                     | Proxy hops in front of the API; `1` on Render        |
| `RATE_LIMIT_WINDOW_MS`                                               | No           | `60000`                                 |                                                      |
| `RATE_LIMIT_MAX`                                                     | No           | `100`                                   | Requests per window per client IP on `/api`          |
| `TEST_DATABASE_URL`                                                  | Tests only   | `...5433/sparrow_test`                  | Name must end in `_test`                             |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Compose only | `sparrow`, `sparrow`, `sparrow`, `5433` | Local database container                             |

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
| 401    | `UNAUTHENTICATED`     | Missing, invalid or expired token, or unknown user      |
| 403    | `FORBIDDEN`           | Authenticated but not allowed                           |
| 403    | `ACCOUNT_SUSPENDED`   | User is suspended                                       |
| 404    | `NOT_FOUND`           | Unknown route or resource                               |
| 409    | `CONFLICT`            | Uniqueness or state conflict                            |
| 413    | `PAYLOAD_TOO_LARGE`   | JSON body over 100 kB                                   |
| 429    | `RATE_LIMITED`        | Rate limit exceeded; see `Retry-After`                  |
| 503    | `SERVICE_UNAVAILABLE` | A dependency is down (readiness)                        |
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

Clients send `Authorization: Bearer <access token>`. Tokens are HS256 JWTs pinned to `JWT_ISSUER`, `JWT_AUDIENCE` and the `at+jwt` type, and must carry `sub`, `exp` and `iat`. Every verification failure returns the same 401.

The token proves identity only. `authenticate` loads the user's role and status from the database on every request, so a role change or suspension takes effect immediately.

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

Token issuance is not exposed over HTTP yet; phone OTP login adds it.

### Development tokens

```powershell
npm run token:dev -- --phone +2348012345678 --role admin
```

The script creates the user or reuses it by phone, sets the requested role, and prints a one-hour token on stdout. It refuses to run unless `NODE_ENV` is `development` and `DATABASE_URL` points at localhost.

## Rate limiting and hardening

- **Default limit.** Every `/api` route is limited to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client IP. Responses carry standard `RateLimit` and `RateLimit-Policy` headers.
- **Sensitive routes.** Add a stricter limiter with `createRateLimiter({ windowMs, max, keyGenerator })`, keyed on something an attacker cannot rotate cheaply, such as phone number plus IP.
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
