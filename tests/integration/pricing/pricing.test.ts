import request, { type Response } from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "#src/lib/logger.js";
import { createIdempotencyRepository } from "#src/modules/idempotency/idempotency.repository.js";
import { createPricingModules } from "#src/modules/pricing/pricing.module.js";
import { seedApprovedPrices } from "#src/modules/pricing/pricing.repository.js";
import { createUsersRepository } from "#src/modules/users/users.repository.js";
import type { Role } from "#src/types/auth.js";
import { createTestAccount } from "../../helpers/account.js";
import { buildTestApp, testConfig } from "../../helpers/app.js";
import { createTestPrisma, truncateAllTables } from "../../helpers/database.js";
import { errorOf } from "../../helpers/http.js";

const prisma = createTestPrisma();
const config = testConfig();
const { app } = buildTestApp({
  config,
  authSubjects: createUsersRepository(prisma),
  idempotency: createIdempotencyRepository(prisma),
  v1Modules: createPricingModules({
    prisma,
    logger: createLogger({ level: "silent", nodeEnv: "test" }),
  }),
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedApprovedPrices(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const local = {
  service: "standard",
  pickup: "igbesa",
  destination: "igbesa",
};

function account(phone: string, role: Role = "customer") {
  return createTestAccount(prisma, phone, role, config);
}

let idempotencySequence = 0;

function idempotencyKey(): string {
  idempotencySequence += 1;
  return `orders-create-${String(idempotencySequence).padStart(12, "0")}`;
}

interface PricedBody {
  id: string;
  totalNaira: number | null;
  pricingStatus: string;
  currency?: string;
}

function dataOf(response: Response): PricedBody {
  return (response.body as { data: PricedBody }).data;
}

describe("pricing authority", () => {
  it("quotes from the database and does not store an order", async () => {
    const customer = await account("+2348040000001");

    const response = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(200);

    expect(dataOf(response)).toMatchObject({
      pricingStatus: "auto",
      totalNaira: 800,
      currency: "NGN",
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a tampered total and leaves no order behind", async () => {
    const customer = await account("+2348040000002");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({ ...local, totalNaira: 1 })
      .expect(400);

    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    expect(errorOf(response).details?.[0]).toMatchObject({ path: "body" });
    expect(errorOf(response).details?.[0]?.message).toContain("totalNaira");
    expect(await prisma.order.count()).toBe(0);
  });

  it("snapshots the server total onto the order", async () => {
    const customer = await account("+2348040000003");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send(local)
      .expect(201);

    const body = dataOf(response);
    expect(body.totalNaira).toBe(800);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(stored).toMatchObject({
      customerId: customer.user.id,
      totalNaira: 800,
      zoneAmountNaira: 800,
      pricingStatus: "auto",
    });
  });

  it("keeps historical totals when operations changes the price list", async () => {
    const customer = await account("+2348040000004");
    const admin = await account("+2348040000005", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send(local)
      .expect(201);
    const orderId = dataOf(created).id;
    const before = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/A")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "automatic", amountNaira: 950 })
      .expect(200);

    const quote = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(200);
    expect(dataOf(quote).totalNaira).toBe(950);

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(after.totalNaira).toBe(800);
    expect(after.zoneAmountNaira).toBe(800);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("keeps an agreed manual total after the price list changes", async () => {
    const customer = await account("+2348040000006");
    const admin = await account("+2348040000007", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({
        service: "standard",
        pickup: "igbesa",
        destination: "outside",
      })
      .expect(201);
    expect(dataOf(created)).toMatchObject({
      pricingStatus: "pending_manual_quote",
      totalNaira: null,
    });

    const quoted = await request(app)
      .post(`/api/v1/orders/${dataOf(created).id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountNaira: 1750 })
      .expect(200);
    expect(dataOf(quoted)).toMatchObject({
      pricingStatus: "manual_quoted",
      totalNaira: 1750,
    });

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/outside_area")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "automatic", amountNaira: 2000 })
      .expect(200);

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(created).id },
    });
    expect(stored).toMatchObject({
      totalNaira: 1750,
      pricingStatus: "manual_quoted",
      quotedById: admin.user.id,
      zoneAmountNaira: null,
    });
    expect(stored.quotedAt).toBeInstanceOf(Date);

    await request(app)
      .post(`/api/v1/orders/${stored.id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountNaira: 1800 })
      .expect(409);
  });

  it("prices a simple errand from the task tier alone", async () => {
    const customer = await account("+2348040000013");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({ service: "errand", errandTier: "simple" })
      .expect(201);

    expect(dataOf(response).totalNaira).toBe(500);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
    });
    expect(stored).toMatchObject({
      errandTier: "simple",
      errandAmountNaira: 500,
      zoneAmountNaira: null,
      totalNaira: 500,
    });
  });

  it("prices a special pickup as zone fee plus collection fee", async () => {
    const customer = await account("+2348040000008");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({
        service: "special_pickup",
        pickup: "igbesa",
        destination: "lusada",
        collection: "igbesa",
      })
      .expect(201);

    expect(dataOf(response).totalNaira).toBe(1500);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
    });
    expect(stored).toMatchObject({
      zoneAmountNaira: 1000,
      specialPickupAmountNaira: 500,
      totalNaira: 1500,
    });
  });

  it("blocks customers from editing prices and riders from creating orders", async () => {
    const customer = await account("+2348040000009");
    const rider = await account("+2348040000010", "rider");

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/A")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ quoteMode: "automatic", amountNaira: 1 })
      .expect(403);

    await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${rider.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send(local)
      .expect(403);

    const rule = await prisma.priceRule.findUniqueOrThrow({
      where: {
        component_tier: { component: "standard_zone", tier: "A" },
      },
    });
    expect(rule.amountNaira).toBe(800);
  });

  it("returns not found when the price rule or order does not exist", async () => {
    const admin = await account("+2348040000014", "admin");

    await request(app)
      .patch("/api/v1/pricing/rules/errand/nope")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "manual" })
      .expect(404);

    await request(app)
      .post("/api/v1/orders/00000000-0000-4000-8000-000000000000/manual-quote")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountNaira: 1500 })
      .expect(404);
  });

  it("stores only one of two racing manual quotes", async () => {
    const customer = await account("+2348040000016");
    const admin = await account("+2348040000017", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({
        service: "standard",
        pickup: "outside",
        destination: "igbesa",
      })
      .expect(201);
    const orderId = dataOf(created).id;

    const [low, high] = await Promise.all([
      request(app)
        .post(`/api/v1/orders/${orderId}/manual-quote`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ amountNaira: 1600 }),
      request(app)
        .post(`/api/v1/orders/${orderId}/manual-quote`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ amountNaira: 2400 }),
    ]);
    expect([low.status, high.status].sort()).toEqual([200, 409]);

    const winner = [low, high].find((response) => response.status === 200);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(winner).toBeDefined();
    expect(stored.totalNaira).toBe(dataOf(winner ?? low).totalNaira);
    expect([1600, 2400]).toContain(stored.totalNaira);
  });

  it("does not fall back to a built-in price when the list is empty", async () => {
    const customer = await account("+2348040000011");
    await prisma.priceRule.deleteMany();

    const response = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(503);

    expect(errorOf(response).code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("pricing database constraints", () => {
  it("rejects an automatic rule with no amount", async () => {
    await expect(
      prisma.priceRule.update({
        where: {
          component_tier: { component: "standard_zone", tier: "A" },
        },
        data: { amountNaira: null },
      }),
    ).rejects.toThrow(/price_rules_amount_mode_check/);
  });

  it("rejects an automatic total that drops a priced leg", async () => {
    const customer = await account("+2348040000015");
    await expect(
      prisma.order.create({
        data: {
          customerId: customer.user.id,
          serviceType: "special_pickup",
          pickupPlace: "igbesa",
          destinationPlace: "lusada",
          collectionPlace: "igbesa",
          pricingStatus: "auto",
          zoneTier: "B",
          zoneAmountNaira: 1000,
          specialPickupTier: "local",
          specialPickupAmountNaira: 500,
          totalNaira: 1000,
        },
      }),
    ).rejects.toThrow(/orders_auto_components_check/);
  });

  it("rejects an automatic order with no priced zone", async () => {
    const customer = await account("+2348040000012");
    await expect(
      prisma.order.create({
        data: {
          customerId: customer.user.id,
          serviceType: "standard",
          pricingStatus: "auto",
          pickupPlace: "igbesa",
          destinationPlace: "igbesa",
        },
      }),
    ).rejects.toThrow(/orders_auto_components_check/);
  });
});
