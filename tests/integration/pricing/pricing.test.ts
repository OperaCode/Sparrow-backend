import request, { type Response } from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "#src/lib/logger.js";
import { createIdempotencyRepository } from "#src/modules/idempotency/idempotency.repository.js";
import {
  OUTSIDE_CORRIDOR_POINT,
  samplePoint,
} from "#src/modules/pricing/pricing.areas.js";
import { createPricingModules } from "#src/modules/pricing/pricing.module.js";
import {
  seedApprovedAreas,
  seedApprovedPrices,
} from "../../helpers/pricing.js";
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
  await seedApprovedAreas(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const local = {
  service: "standard",
  pickup: samplePoint("igbesa"),
  destination: samplePoint("igbesa"),
};

const outsideTrip = {
  service: "standard",
  pickup: samplePoint("igbesa"),
  destination: OUTSIDE_CORRIDOR_POINT,
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
  totalKobo: number | null;
  minimumTotalKobo?: number | null;
  pricingStatus: string;
  currency?: string;
  pickupPlace?: string | null;
  destinationPlace?: string | null;
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
      totalKobo: 80000,
      currency: "NGN",
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a tampered total and leaves no order behind", async () => {
    const customer = await account("+2348040000002");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ ...local, totalKobo: 1 })
      .expect(400);

    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    expect(errorOf(response).details?.[0]).toMatchObject({ path: "body" });
    expect(errorOf(response).details?.[0]?.message).toContain("totalKobo");
    expect(await prisma.order.count()).toBe(0);
  });

  it("snapshots the server total onto the order", async () => {
    const customer = await account("+2348040000003");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(201);

    const body = dataOf(response);
    expect(body.totalKobo).toBe(80000);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(stored).toMatchObject({
      customerId: customer.user.id,
      totalKobo: 80000,
      zoneAmountKobo: 80000,
      pricingStatus: "auto",
      pickupPlace: "igbesa",
      destinationPlace: "igbesa",
      minimumTotalKobo: null,
    });
    expect(stored.pickupLatitude).toBeCloseTo(samplePoint("igbesa").latitude);
    expect(stored.pickupLongitude).toBeCloseTo(samplePoint("igbesa").longitude);
  });

  it("prices the coordinates and rejects a named community", async () => {
    const customer = await account("+2348040000018");

    const named = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        service: "standard",
        pickup: "igbesa",
        destination: "igbesa",
      })
      .expect(400);
    expect(errorOf(named).code).toBe("VALIDATION_ERROR");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        service: "standard",
        pickup: samplePoint("ketu"),
        destination: samplePoint("igbesa"),
      })
      .expect(201);

    expect(dataOf(response).totalKobo).toBe(130000);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
    });
    expect(stored).toMatchObject({
      pickupPlace: "ketu",
      destinationPlace: "igbesa",
      zoneTier: "C",
      zoneAmountKobo: 130000,
      totalKobo: 130000,
    });
  });

  it("keeps historical totals when operations changes the price list", async () => {
    const customer = await account("+2348040000004");
    const admin = await account("+2348040000005", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(201);
    const orderId = dataOf(created).id;
    const before = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/A")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "automatic", amountKobo: 95000 })
      .expect(200);

    const changes = await prisma.priceRuleChange.findMany({
      where: { actorId: admin.user.id },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      component: "standard_zone",
      tier: "A",
      actorId: admin.user.id,
      oldQuoteMode: "automatic",
      oldAmountKobo: 80000,
      oldMinimumKobo: null,
      newQuoteMode: "automatic",
      newAmountKobo: 95000,
      newMinimumKobo: null,
    });
    expect(changes[0]?.createdAt).toBeInstanceOf(Date);

    const quote = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(200);
    expect(dataOf(quote).totalKobo).toBe(95000);

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(after.totalKobo).toBe(80000);
    expect(after.zoneAmountKobo).toBe(80000);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("keeps an agreed manual total after the price list changes", async () => {
    const customer = await account("+2348040000006");
    const admin = await account("+2348040000007", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(outsideTrip)
      .expect(201);
    expect(dataOf(created)).toMatchObject({
      pricingStatus: "pending_manual_quote",
      totalKobo: null,
      minimumTotalKobo: 150000,
      destinationPlace: "outside",
    });

    const tooLow = await request(app)
      .post(`/api/v1/orders/${dataOf(created).id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 1 })
      .expect(400);
    expect(errorOf(tooLow).details?.[0]).toMatchObject({
      path: "body.amountKobo",
    });
    expect(errorOf(tooLow).details?.[0]?.message).toContain("150000");

    const quoted = await request(app)
      .post(`/api/v1/orders/${dataOf(created).id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 175000 })
      .expect(200);
    expect(dataOf(quoted)).toMatchObject({
      pricingStatus: "manual_quoted",
      totalKobo: 175000,
    });

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/outside_area")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "automatic", amountKobo: 200000 })
      .expect(200);

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(created).id },
    });
    expect(stored).toMatchObject({
      totalKobo: 175000,
      pricingStatus: "manual_quoted",
      quotedById: admin.user.id,
      zoneAmountKobo: null,
    });
    expect(stored.quotedAt).toBeInstanceOf(Date);

    await request(app)
      .post(`/api/v1/orders/${stored.id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 180000 })
      .expect(409);
  });

  it("prices a simple errand from the task tier alone", async () => {
    const customer = await account("+2348040000013");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ service: "errand", errandTier: "simple" })
      .expect(201);

    expect(dataOf(response).totalKobo).toBe(50000);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
    });
    expect(stored).toMatchObject({
      errandTier: "simple",
      errandAmountKobo: 50000,
      zoneAmountKobo: null,
      totalKobo: 50000,
    });
  });

  it("prices a special pickup as zone fee plus collection fee", async () => {
    const customer = await account("+2348040000008");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        service: "special_pickup",
        pickup: samplePoint("igbesa"),
        destination: samplePoint("lusada"),
        collection: samplePoint("igbesa"),
      })
      .expect(201);

    expect(dataOf(response).totalKobo).toBe(150000);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
    });
    expect(stored).toMatchObject({
      zoneAmountKobo: 100000,
      specialPickupAmountKobo: 50000,
      totalKobo: 150000,
    });
  });

  it("blocks customers from editing prices and riders from creating orders", async () => {
    const customer = await account("+2348040000009");
    const rider = await account("+2348040000010", "rider");

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/A")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ quoteMode: "automatic", amountKobo: 1 })
      .expect(403);

    await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${rider.token}`)
      .send(local)
      .expect(403);

    const rule = await prisma.priceRule.findUniqueOrThrow({
      where: {
        component_tier: { component: "standard_zone", tier: "A" },
      },
    });
    expect(rule.amountKobo).toBe(80000);
  });

  it("returns not found when the price rule or order does not exist", async () => {
    const admin = await account("+2348040000014", "admin");

    await request(app)
      .patch("/api/v1/pricing/rules/errand/nope")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "manual", minimumKobo: 150000 })
      .expect(404);

    await request(app)
      .post("/api/v1/orders/00000000-0000-4000-8000-000000000000/manual-quote")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 150000 })
      .expect(404);
  });

  it("stores only one of two racing manual quotes", async () => {
    const customer = await account("+2348040000016");
    const admin = await account("+2348040000017", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        service: "standard",
        pickup: OUTSIDE_CORRIDOR_POINT,
        destination: samplePoint("igbesa"),
      })
      .expect(201);
    const orderId = dataOf(created).id;

    const [low, high] = await Promise.all([
      request(app)
        .post(`/api/v1/orders/${orderId}/manual-quote`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ amountKobo: 160000 }),
      request(app)
        .post(`/api/v1/orders/${orderId}/manual-quote`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ amountKobo: 240000 }),
    ]);
    expect([low.status, high.status].sort()).toEqual([200, 409]);

    const winner = [low, high].find((response) => response.status === 200);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(winner).toBeDefined();
    expect(stored.totalKobo).toBe(dataOf(winner ?? low).totalKobo);
    expect([160000, 240000]).toContain(stored.totalKobo);
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

  it("keeps the snapshotted floor when operations raises the minimum", async () => {
    const customer = await account("+2348040000019");
    const admin = await account("+2348040000020", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(outsideTrip)
      .expect(201);
    const orderId = dataOf(created).id;

    await request(app)
      .patch("/api/v1/pricing/rules/standard_zone/outside_area")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ quoteMode: "manual", minimumKobo: 300000 })
      .expect(200);

    const quoted = await request(app)
      .post(`/api/v1/orders/${orderId}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 160000 })
      .expect(200);
    expect(dataOf(quoted).totalKobo).toBe(160000);

    const later = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(outsideTrip)
      .expect(201);
    expect(dataOf(later).minimumTotalKobo).toBe(300000);
    await request(app)
      .post(`/api/v1/orders/${dataOf(later).id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 160000 })
      .expect(400);

    const original = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(original).toMatchObject({
      totalKobo: 160000,
      minimumTotalKobo: 150000,
    });
  });

  it("reclassifies new trips when an area moves and leaves priced orders alone", async () => {
    const customer = await account("+2348040000021");
    const admin = await account("+2348040000022", "admin");
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(201);

    await request(app)
      .patch("/api/v1/pricing/areas/igbesa")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        minLatitude: 1,
        maxLatitude: 2,
        minLongitude: 1,
        maxLongitude: 2,
      })
      .expect(403);

    await request(app)
      .patch("/api/v1/pricing/areas/igbesa")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        minLatitude: 1,
        maxLatitude: 2,
        minLongitude: 1,
        maxLongitude: 2,
      })
      .expect(200);

    const quote = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(local)
      .expect(200);
    expect(dataOf(quote)).toMatchObject({
      pricingStatus: "pending_manual_quote",
      totalKobo: null,
      minimumTotalKobo: 150000,
      pickupPlace: "extended",
      destinationPlace: "extended",
    });

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(created).id },
    });
    expect(stored).toMatchObject({
      totalKobo: 80000,
      pickupPlace: "igbesa",
      destinationPlace: "igbesa",
    });
  });
});

describe("pricing database constraints", () => {
  it("rejects an automatic rule with no amount", async () => {
    await expect(
      prisma.priceRule.update({
        where: {
          component_tier: { component: "standard_zone", tier: "A" },
        },
        data: { amountKobo: null },
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
          zoneAmountKobo: 100000,
          specialPickupTier: "local",
          specialPickupAmountKobo: 50000,
          totalKobo: 100000,
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

  it("rejects a stored manual total below its floor", async () => {
    const customer = await account("+2348040000023");
    await expect(
      prisma.order.create({
        data: {
          customerId: customer.user.id,
          quotedById: customer.user.id,
          quotedAt: new Date(),
          serviceType: "standard",
          pickupPlace: "extended",
          destinationPlace: "igbesa",
          pricingStatus: "manual_quoted",
          zoneTier: "extended",
          totalKobo: 1,
          minimumTotalKobo: 150000,
        },
      }),
    ).rejects.toThrow(/orders_quote_floor_check/);
  });
});
