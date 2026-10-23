import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConflictError } from "#src/http/errors.js";
import { createErrorHandler } from "#src/http/middleware/error-handler.js";
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  createIdempotency,
} from "#src/http/middleware/idempotency.js";
import { requestId } from "#src/http/middleware/request-id.js";
import { validate } from "#src/http/middleware/validate.js";
import { sendData } from "#src/http/response.js";
import { createLogger } from "#src/lib/logger.js";
import type {
  IdempotencyBegin,
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

interface Stored {
  id: string;
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
  state: "processing" | "completed";
  statusCode?: number;
  body?: unknown;
}

function memoryStore(): IdempotencyStore {
  const rows: Stored[] = [];

  return {
    begin(claim: IdempotencyClaim): Promise<IdempotencyBegin> {
      const existing = rows.find(
        (row) =>
          row.actorId === claim.actorId &&
          row.scope === claim.scope &&
          row.key === claim.key,
      );
      if (existing === undefined) {
        const row: Stored = {
          id: `record-${rows.length + 1}`,
          actorId: claim.actorId,
          scope: claim.scope,
          key: claim.key,
          requestHash: claim.requestHash,
          state: "processing",
        };
        rows.push(row);
        return Promise.resolve({ outcome: "started", id: row.id });
      }
      if (existing.requestHash !== claim.requestHash) {
        return Promise.resolve({ outcome: "mismatch" });
      }
      if (existing.state === "completed") {
        return Promise.resolve({
          outcome: "replay",
          statusCode: existing.statusCode ?? 500,
          body: existing.body,
        });
      }
      return Promise.resolve({ outcome: "in_progress" });
    },

    complete(id, statusCode, body) {
      const row = rows.find((item) => item.id === id);
      if (row === undefined || row.state !== "processing") {
        return Promise.reject(new Error("not processing"));
      }
      row.state = "completed";
      row.statusCode = statusCode;
      row.body = body;
      return Promise.resolve();
    },

    abandon(id) {
      const index = rows.findIndex(
        (row) => row.id === id && row.state === "processing",
      );
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve();
    },
  };
}

function buildApp(options: {
  store?: IdempotencyStore;
  authenticate?: boolean;
  failOnce?: { current: boolean };
  conflict?: boolean;
}) {
  const capture = createLogCapture();
  const logger = createLogger(
    { level: "info", nodeEnv: "test" },
    capture.stream,
  );
  const store = options.store ?? memoryStore();
  const guard = createIdempotency(store, logger);
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
      if (options.failOnce?.current === true) {
        options.failOnce.current = false;
        throw new Error("downstream");
      }
      if (options.conflict === true && calls.count === 1) {
        throw new ConflictError("Order cannot be created");
      }
      const body = req.body as { destination: string };
      sendData(
        res,
        { id: "order-1", destination: body.destination },
        {
          status: 201,
        },
      );
    },
  );
  app.use(createErrorHandler(logger));
  return { app, calls, capture, store };
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
  it("rejects a missing or malformed key before the handler runs", async () => {
    const { app, calls, store } = buildApp({});
    let began = false;
    store.begin = () => {
      began = true;
      return Promise.resolve({ outcome: "in_progress" });
    };

    const missing = await post(app, undefined, "igbesa").expect(400);
    const malformed = await post(app, "short", "igbesa").expect(400);

    expect(errorOf(missing).details).toEqual(errorOf(malformed).details);
    expect(errorOf(missing).details?.[0]?.path).toBe("header.Idempotency-Key");
    expect(began).toBe(false);
    expect(calls.count).toBe(0);
  });

  it("replays the first response and does not run the handler again", async () => {
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

  it("does not claim a key when the payload fails validation", async () => {
    const { app, store } = buildApp({});
    let began = false;
    const begin = store.begin.bind(store);
    store.begin = (claim) => {
      began = true;
      return begin(claim);
    };

    await request(app)
      .post("/orders")
      .set("Idempotency-Key", KEY)
      .send({ destination: "" })
      .expect(400);

    expect(began).toBe(false);
    await post(app, KEY, "igbesa").expect(201);
  });

  it("releases the key when the handler fails unexpectedly", async () => {
    const failOnce = { current: true };
    const { app } = buildApp({ failOnce });

    await post(app, KEY, "igbesa").expect(500);
    const retried = await post(app, KEY, "igbesa").expect(201);

    expect(retried.headers["idempotency-replayed"]).toBeUndefined();
    expect(retried.body).toEqual({
      data: { id: "order-1", destination: "igbesa" },
    });
  });

  it("replays a stored conflict instead of running the action again", async () => {
    const { app, calls } = buildApp({ conflict: true });

    const first = await post(app, KEY, "igbesa").expect(409);
    const second = await post(app, KEY, "igbesa").expect(409);

    expect(errorOf(first).code).toBe("CONFLICT");
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe(
      "true",
    );
    expect(second.body).toEqual(first.body);
    expect(calls.count).toBe(1);
  });

  it("reports a key that is still in progress", async () => {
    const store: IdempotencyStore = {
      begin: () => Promise.resolve({ outcome: "in_progress" }),
      complete: () => Promise.resolve(),
      abandon: () => Promise.resolve(),
    };
    const { app, calls } = buildApp({ store });

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
    const capture = createLogCapture();
    const logger = createLogger(
      { level: "silent", nodeEnv: "test" },
      capture.stream,
    );

    expect(() => createIdempotency(memoryStore(), logger)("Orders")).toThrow(
      /Invalid idempotency scope/,
    );
  });
});
