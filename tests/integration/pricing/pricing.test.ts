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
  customerId?: string;
  collection?: {
    kind?: string;
    place?: string;
    address?: string;
    contactName?: string;
    contactPhone?: string;
  } | null;
  components?: {
    component: string;
    amountKobo: number | null;
    tier?: string;
  }[];
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
        collection: {
          ...samplePoint("igbesa"),
          address: "14 Market Road, Igbesa",
          landmark: "Opposite the pharmacy",
          contactName: "Ada Okonkwo",
          contactPhone: "+2348011111111",
        },
      })
      .expect(201);

    expect(dataOf(response).totalKobo).toBe(150000);
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: dataOf(response).id },
      include: { collection: true },
    });
    expect(stored).toMatchObject({
      serviceType: "special_pickup",
      zoneAmountKobo: 100000,
      specialPickupAmountKobo: 50000,
      totalKobo: 150000,
      pickupPlace: "igbesa",
      collectionPlace: "igbesa",
      collection: {
        address: "14 Market Road, Igbesa",
        landmark: "Opposite the pharmacy",
        contactName: "Ada Okonkwo",
        contactPhone: "+2348011111111",
      },
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

  it("rejects a special pickup that has no separate collection", async () => {
    const customer = await account("+2348040000030");
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
          totalKobo: 150000,
        },
      }),
    ).rejects.toThrow(/orders_collection_cardinality_check/);
  });

  it("rejects a collection on a standard delivery", async () => {
    const customer = await account("+2348040000031");
    const order = await prisma.order.create({
      data: {
        customerId: customer.user.id,
        serviceType: "standard",
        pickupPlace: "igbesa",
        destinationPlace: "igbesa",
        pricingStatus: "auto",
        zoneTier: "A",
        zoneAmountKobo: 80000,
        totalKobo: 80000,
      },
    });

    await expect(
      prisma.orderCollection.create({
        data: {
          orderId: order.id,
          address: "14 Market Road",
          contactName: "Ada Okonkwo",
          contactPhone: "+2348011111111",
        },
      }),
    ).rejects.toThrow(/orders_collection_cardinality_check/);
  });

  it("rejects a collection on an errand", async () => {
    const customer = await account("+2348040000032");
    const order = await prisma.order.create({
      data: {
        customerId: customer.user.id,
        serviceType: "errand",
        errandTier: "simple",
        pricingStatus: "auto",
        errandAmountKobo: 50000,
        totalKobo: 50000,
      },
    });

    await expect(
      prisma.orderCollection.create({
        data: {
          orderId: order.id,
          address: "14 Market Road",
          contactName: "Ada Okonkwo",
          contactPhone: "+2348011111111",
        },
      }),
    ).rejects.toThrow(/orders_collection_cardinality_check/);
  });
});

describe("special pickup requests", () => {
  function collectionAt(
    place: "igbesa" | "lusada" | "ketu",
    contactPhone = "+2348011111111",
  ) {
    return {
      service: "special_pickup" as const,
      pickup: samplePoint("igbesa"),
      destination: samplePoint("igbesa"),
      collection: {
        ...samplePoint(place),
        address: "14 Market Road",
        landmark: "Opposite the pharmacy",
        contactName: "Ada Okonkwo",
        contactPhone,
      },
    };
  }

  it("prices a nearby collection on top of the zone fee", async () => {
    const customer = await account("+2348040000033");

    const response = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(collectionAt("lusada"))
      .expect(201);

    expect(dataOf(response)).toMatchObject({
      totalKobo: 150000,
      collection: {
        kind: "collection",
        place: "lusada",
        address: "14 Market Road",
        contactName: "Ada Okonkwo",
        contactPhone: "+2348011111111",
      },
    });
    expect(dataOf(response).components).toEqual([
      expect.objectContaining({
        component: "standard_zone",
        amountKobo: 80000,
      }),
      expect.objectContaining({
        component: "special_pickup",
        tier: "nearby",
        amountKobo: 70000,
      }),
    ]);
  });

  it("keeps an extended collection as its own manual leg", async () => {
    const customer = await account("+2348040000034");
    const admin = await account("+2348040000035", "admin");

    const created = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set("Authorization", `Bearer ${customer.token}`)
      .send(collectionAt("ketu", "+2348022222222"))
      .expect(201);

    expect(dataOf(created)).toMatchObject({
      pricingStatus: "pending_manual_quote",
      totalKobo: null,
      minimumTotalKobo: 180000,
      collection: {
        kind: "collection",
        place: "ketu",
        contactPhone: "+2348022222222",
      },
    });

    const quoted = await request(app)
      .post(`/api/v1/orders/${dataOf(created).id}/manual-quote`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ amountKobo: 180000 })
      .expect(200);
    expect(dataOf(quoted)).toMatchObject({
      totalKobo: 180000,
      collection: { kind: "collection", place: "ketu" },
    });
  });

  it("rejects a special pickup that omits the collection contact", async () => {
    const customer = await account("+2348040000036");

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
      .expect(400);

    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderCollection.count()).toBe(0);
  });

  it("still previews a special pickup price without storing a stop", async () => {
    const customer = await account("+2348040000037");

    const response = await request(app)
      .post("/api/v1/pricing/quotes")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        service: "special_pickup",
        pickup: samplePoint("igbesa"),
        destination: samplePoint("lusada"),
        collection: samplePoint("igbesa"),
      })
      .expect(200);

    expect(dataOf(response).totalKobo).toBe(150000);
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("operations collection queue", () => {
  function collectionAt(phone: string) {
    return {
      service: "special_pickup" as const,
      pickup: samplePoint("igbesa"),
      destination: samplePoint("lusada"),
      collection: {
        ...samplePoint("igbesa"),
        address: `Stop ${phone}`,
        contactName: "Ada Okonkwo",
        contactPhone: phone,
      },
    };
  }

  it("shows the extra collection leg and hides it on other services", async () => {
    const customer = await account("+2348040000038");
    const admin = await account("+2348040000039", "admin");
    const auth = { Authorization: `Bearer ${customer.token}` };

    const special = await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set(auth)
      .send(collectionAt("+2348033333333"))
      .expect(201);
    await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set(auth)
      .send(local)
      .expect(201);
    await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", idempotencyKey())
      .set(auth)
      .send({ service: "errand", errandTier: "simple" })
      .expect(201);

    const denied = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "special_pickup" })
      .expect(401);
    expect(errorOf(denied).code).toBe("UNAUTHENTICATED");

    const forbidden = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "special_pickup" })
      .set(auth)
      .expect(403);
    expect(errorOf(forbidden).code).toBe("FORBIDDEN");

    const queue = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "special_pickup" })
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const rows = (
      queue.body as {
        data: {
          id: string;
          serviceType: string;
          collection: { kind: string; address: string } | null;
        }[];
      }
    ).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: dataOf(special).id,
      serviceType: "special_pickup",
      collection: {
        kind: "collection",
        address: "Stop +2348033333333",
      },
    });

    const detail = await request(app)
      .get(`/api/v1/orders/${dataOf(special).id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(dataOf(detail)).toMatchObject({
      customerId: customer.user.id,
      collection: { kind: "collection", contactPhone: "+2348033333333" },
    });

    const standards = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "standard" })
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const standardRows = (standards.body as { data: { collection: unknown }[] })
      .data;
    expect(standardRows).toHaveLength(1);
    expect(standardRows[0]?.collection).toBeNull();

    const errands = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "errand" })
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const errandRows = (
      errands.body as {
        data: { collection: unknown; components: { component: string }[] }[];
      }
    ).data;
    expect(errandRows).toHaveLength(1);
    expect(errandRows[0]?.collection).toBeNull();
    expect(
      errandRows[0]?.components.map((component) => component.component),
    ).toEqual(["errand"]);
  });

  it("pages the queue without dropping or repeating a collection", async () => {
    const customer = await account("+2348040000040");
    const admin = await account("+2348040000041", "admin");
    const phones = ["+2348041111111", "+2348041111112", "+2348041111113"];
    for (const phone of phones) {
      await request(app)
        .post("/api/v1/orders")
        .set("Idempotency-Key", idempotencyKey())
        .set("Authorization", `Bearer ${customer.token}`)
        .send({
          service: "special_pickup",
          pickup: samplePoint("igbesa"),
          destination: samplePoint("lusada"),
          collection: {
            ...samplePoint("igbesa"),
            address: "14 Market Road",
            contactName: "Ada Okonkwo",
            contactPhone: phone,
          },
        })
        .expect(201);
    }

    const first = await request(app)
      .get("/api/v1/orders")
      .query({ serviceType: "special_pickup", limit: 2 })
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const firstBody = first.body as {
      data: { id: string; collection: { kind: string } | null }[];
      meta: { limit: number; nextCursor: string | null };
    };
    expect(firstBody.meta).toMatchObject({ limit: 2 });
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get("/api/v1/orders")
      .query({
        serviceType: "special_pickup",
        limit: 2,
        cursor: firstBody.meta.nextCursor,
      })
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const secondBody = second.body as {
      data: { id: string; collection: { kind: string } | null }[];
      meta: { nextCursor: string | null };
    };
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.meta.nextCursor).toBeNull();

    const seen = [...firstBody.data, ...secondBody.data];
    expect(new Set(seen.map((row) => row.id)).size).toBe(3);
    expect(seen.every((row) => row.collection?.kind === "collection")).toBe(
      true,
    );
  });
});
