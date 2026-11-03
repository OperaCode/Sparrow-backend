import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createErrorHandler } from "#src/http/middleware/error-handler.js";
import { createIdempotency } from "#src/http/middleware/idempotency.js";
import { requestId } from "#src/http/middleware/request-id.js";
import { validate } from "#src/http/middleware/validate.js";
import { createLogger } from "#src/lib/logger.js";
import type {
  IdempotencyClaim,
  IdempotencyStore,
} from "#src/types/idempotency.js";
import { errorOf } from "../../helpers/http.js";
import { createLogCapture } from "../../helpers/log-capture.js";

const USER_ID = "3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11";
const KEY = "orders-create-unit-key";

const bodySchema = z.strictObject({
  destination: z.string().min(1),
});

interface Stored extends IdempotencyClaim {
  state: "processing" | "completed";
  statusCode?: number;
  body?: unknown;
}

function memoryStore() {
  const rows: Stored[] = [];
  const calls = { recoveries: 0 };
  const store: IdempotencyStore = {
    recover(claim) {
      calls.recoveries += 1;
      const existing = rows.find(
        (row) =>
          row.actorId === claim.actorId &&
          row.scope === claim.scope &&
          row.key === claim.key,
      );
      if (existing === undefined) return Promise.resolve({ outcome: "fresh" });
      if (existing.requestHash !== claim.requestHash) {
        return Promise.resolve({ outcome: "mismatch" });
      }
      if (
        existing.state !== "completed" ||
        existing.statusCode === undefined ||
        existing.body === undefined
      ) {
        return Promise.resolve({ outcome: "in_progress" });
      }
      return Promise.resolve({
        outcome: "replay",
        statusCode: existing.statusCode,
        body: existing.body,
      });
    },
  };
  return { store, rows, calls };
}

function buildApp(options: {
  store?: IdempotencyStore;
  rows?: Stored[];
  authenticate?: boolean;
  failOnce?: { current: boolean };
}) {
  const capture = createLogCapture();
  const logger = createLogger(
    { level: "info", nodeEnv: "test" },
    capture.stream,
  );
  const memory = memoryStore();
  const store = options.store ?? memory.store;
  const rows = options.rows ?? memory.rows;
  const guard = createIdempotency(store);
  const calls = { count: 0 };
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.post(
    "/orders",
    (req, _res, next) => {
      if (options.authenticate !== false) {
        req.auth = { userId: USER_ID, role: "customer" };
      }
      next();
    },
    validate({ body: bodySchema }),
    guard("orders.create"),
    (req, res) => {
      calls.count += 1;
      const claim = req.idempotency;
      if (claim === undefined) {
        throw new Error("createOrder requires an idempotency claim");
      }
      if (options.failOnce?.current === true) {
        options.failOnce.current = false;
        throw new Error("downstream");
      }
      const body = req.body as { destination: string };
      const response = {
        data: { id: "order-1", destination: body.destination },
      };
      rows.push({
        ...claim,
        state: "completed",
        statusCode: 201,
        body: response,
      });
      res.status(201).json(response);
    },
  );
  app.use(createErrorHandler(logger));
  return { app, calls, capture, store, rows };
}

function post(
  app: express.Express,
  key: string | undefined,
  destination: string,
) {
  const req = request(app).post("/orders");
  if (key !== undefined) req.set("Idempotency-Key", key);
  return req.send({ destination });
}

describe("idempotency", () => {
  it("rejects a missing or malformed key before reading the store", async () => {
    const seen = { recoveries: 0 };
    const { app, calls } = buildApp({
      store: {
        recover() {
          seen.recoveries += 1;
          return Promise.resolve({ outcome: "fresh" });
        },
      },
    });

    const missing = await post(app, undefined, "igbesa").expect(400);
    const malformed = await post(app, "short", "igbesa").expect(400);

    expect(errorOf(missing).details).toEqual(errorOf(malformed).details);
    expect(errorOf(missing).details?.[0]?.path).toBe("header.Idempotency-Key");
    expect(seen.recoveries).toBe(0);
    expect(calls.count).toBe(0);
  });

  it("replays a result stored with the order and does not run the handler again", async () => {
    const { app, calls } = buildApp({});

    const first = await post(app, KEY, "igbesa").expect(201);
    const second = await post(app, KEY, "igbesa").expect(201);

    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(calls.count).toBe(1);
  });

  it("refuses the same key when the body differs", async () => {
    const { app, calls } = buildApp({});

    await post(app, KEY, "igbesa").expect(201);
    const response = await post(app, KEY, "lusada").expect(409);

    expect(errorOf(response).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(calls.count).toBe(1);
  });

  it("does not read the store when the payload fails validation", async () => {
    const memory = memoryStore();
    const recover = memory.store.recover.bind(memory.store);
    let recoveries = 0;
    memory.store.recover = (claim) => {
      recoveries += 1;
      return recover(claim);
    };
    const { app } = buildApp({ store: memory.store, rows: memory.rows });

    await request(app)
      .post("/orders")
      .set("Idempotency-Key", KEY)
      .send({ destination: "" })
      .expect(400);

    expect(recoveries).toBe(0);
    await post(app, KEY, "igbesa").expect(201);
  });

  it("leaves no record when the handler fails before anything commits", async () => {
    const failOnce = { current: true };
    const { app, calls, rows } = buildApp({ failOnce });

    await post(app, KEY, "igbesa").expect(500);
    expect(rows).toHaveLength(0);

    const retried = await post(app, KEY, "igbesa").expect(201);

    expect(retried.headers["idempotency-replayed"]).toBeUndefined();
    expect(retried.body).toEqual({
      data: { id: "order-1", destination: "igbesa" },
    });
    expect(calls.count).toBe(2);
  });

  it("does not take over a key that has no finished result", async () => {
    const { app, calls } = buildApp({
      store: {
        recover: () => Promise.resolve({ outcome: "in_progress" }),
      },
    });

    const response = await post(app, KEY, "igbesa").expect(409);

    expect(errorOf(response).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(calls.count).toBe(0);
  });

  it("fails closed when the guard is mounted without authenticate", async () => {
    const { app, capture } = buildApp({ authenticate: false });

    const response = await post(app, KEY, "igbesa").expect(500);

    expect(errorOf(response).code).toBe("INTERNAL_ERROR");
    expect(capture.raw()).toContain(
      "idempotency must be mounted after authenticate",
    );
  });

  it("rejects a scope that is not an operation name", () => {
    expect(() => createIdempotency(memoryStore().store)("Orders")).toThrow(
      /Invalid idempotency scope/,
    );
  });
});
