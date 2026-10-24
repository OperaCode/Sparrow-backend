import { describe, expect, it } from 'vitest';
import { createLogger } from '#src/lib/logger.js';
import type { AuditActor } from '#src/types/auth.js';
import type { IdempotencyClaim } from '#src/types/idempotency.js';
import {
  APPROVED_SERVICE_AREAS,
  samplePoint,
} from '#src/modules/pricing/pricing.areas.js';
import { APPROVED_PRICE_RULES } from '#src/modules/pricing/pricing.catalog.js';
import { assertServiceAreaMap } from '#src/modules/pricing/pricing.locate.js';
import { PricingConfigurationError } from '#src/modules/pricing/pricing.money.js';
import type {
  CreatePricedOrderArgs,
  ManualQuoteWriteResult,
  PricingRepository,
} from '#src/modules/pricing/pricing.repository.js';
import {
  createPricingService,
  type PricingService,
} from '#src/modules/pricing/pricing.service.js';
import type {
  PriceRuleRecord,
  PricedOrder,
  QuoteRequest,
  RuleUpdate,
  ServiceArea,
} from '#src/modules/pricing/pricing.types.js';

interface Memory {
  repository: PricingRepository;
  orders: PricedOrder[];
}

function memoryRepository(
  initial: readonly PriceRuleRecord[],
  initialAreas: readonly ServiceArea[],
): Memory {
  const rules = initial.map((rule) => ({ ...rule }));
  const areas = initialAreas.map((area) => ({ ...area }));
  const orders: PricedOrder[] = [];
  const saved = new Map<string, { hash: string; order: PricedOrder }>();

  const repository: PricingRepository = {
    listRules() {
      return Promise.resolve(rules.map((rule) => ({ ...rule })));
    },

    updateRule(component, tier, patch: RuleUpdate) {
      const rule = rules.find(
        (item) => item.component === component && item.tier === tier,
      );
      if (rule === undefined) return Promise.resolve(null);
      rule.quoteMode = patch.quoteMode;
      rule.amountKobo = patch.amountKobo;
      rule.minimumKobo = patch.minimumKobo;
      return Promise.resolve({ ...rule });
    },

    listAreas() {
      return Promise.resolve(areas.map((area) => ({ ...area })));
    },

    updateArea(place, box) {
      const index = areas.findIndex((area) => area.place === place);
      if (index < 0) return Promise.resolve('missing');
      const next = areas.map((area, areaIndex) =>
        areaIndex === index ? { place, ...box } : { ...area },
      );
      try {
        assertServiceAreaMap(next);
      } catch (error) {
        if (error instanceof PricingConfigurationError) {
          return Promise.resolve('invalid');
        }
        throw error;
      }
      const updated = next[index];
      if (updated === undefined) return Promise.resolve('missing');
      areas[index] = updated;
      return Promise.resolve({ ...updated });
    },

    createPricedOrder({
      request,
      quoteFromRules,
      claim,
    }: CreatePricedOrderArgs) {
      const id = `${claim.actorId}:${claim.scope}:${claim.key}`;
      const previous = saved.get(id);
      if (previous !== undefined) {
        if (previous.hash !== claim.requestHash) {
          return Promise.resolve({ outcome: 'mismatch' });
        }
        return Promise.resolve({
          outcome: 'replay',
          statusCode: 201,
          body: { data: previous.order },
        });
      }
      const quote = quoteFromRules(
        rules.map((rule) => ({ ...rule })),
        areas.map((area) => ({ ...area })),
      );
      const order: PricedOrder = {
        id: `order-${orders.length + 1}`,
        serviceType: request.service,
        pricingStatus: quote.pricingStatus,
        currency: 'NGN',
        components: quote.components.map((component) => ({ ...component })),
        totalKobo: quote.totalKobo,
        minimumTotalKobo: quote.minimumTotalKobo,
        pickupPlace: quote.pickupPlace,
        destinationPlace: quote.destinationPlace,
        collectionPlace: quote.collectionPlace,
      };
      orders.push(order);
      const copy = {
        ...order,
        components: order.components.map((component) => ({ ...component })),
      };
      saved.set(id, { hash: claim.requestHash, order: copy });
      return Promise.resolve({ outcome: 'created', order: copy });
    },

    findOrder(id) {
      const order = orders.find((item) => item.id === id);
      if (order === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ...order,
        components: order.components.map((component) => ({ ...component })),
      });
    },

    applyManualQuote(id, amountKobo): Promise<ManualQuoteWriteResult> {
      const order = orders.find((item) => item.id === id);
      if (order === undefined) return Promise.resolve('missing');
      if (order.pricingStatus !== 'pending_manual_quote') {
        return Promise.resolve('not_pending');
      }
      if (
        order.minimumTotalKobo === null ||
        amountKobo < order.minimumTotalKobo
      ) {
        return Promise.resolve({
          belowMinimum: order.minimumTotalKobo ?? 0,
        });
      }
      order.pricingStatus = 'manual_quoted';
      order.totalKobo = amountKobo;
      return Promise.resolve({
        ...order,
        components: order.components.map((component) => ({ ...component })),
      });
    },
  };

  return { repository, orders };
}

function serviceWith(
  initial: readonly PriceRuleRecord[] = APPROVED_PRICE_RULES,
  initialAreas: readonly ServiceArea[] = APPROVED_SERVICE_AREAS,
) {
  const memory = memoryRepository(initial, initialAreas);
  const service = createPricingService({
    repository: memory.repository,
    logger: createLogger({ level: 'silent', nodeEnv: 'test' }),
  });
  return { ...memory, service };
}

const admin: AuditActor = {
  actorId: 'admin-1',
  requestId: 'request-admin-1',
};

let claimSequence = 0;

function claim(): IdempotencyClaim {
  claimSequence += 1;
  return {
    actorId: 'customer-1',
    scope: 'orders.create',
    key: `orders-create-${String(claimSequence).padStart(8, '0')}`,
    requestHash: 'a'.repeat(64),
  };
}

async function place(
  service: PricingService,
  request: QuoteRequest,
): Promise<PricedOrder> {
  const result = await service.createOrder('customer-1', request, claim());
  if (result.outcome !== 'created') {
    throw new Error('expected a new order');
  }
  return result.order;
}

const local: QuoteRequest = {
  service: 'standard',
  pickup: samplePoint('igbesa'),
  destination: samplePoint('igbesa'),
};

const automatic = {
  quoteMode: 'automatic' as const,
  minimumKobo: null,
};

describe('pricing service', () => {
  it('keeps a snapshotted total after the price list changes', async () => {
    const { service, orders } = serviceWith();
    const order = await place(service, local);
    expect(order.totalKobo).toBe(80_000);

    await service.updateRule(
      'standard_zone',
      'A',
      {
        ...automatic,
        amountKobo: 95_000,
      },
      admin,
    );

    await expect(service.quote(local)).resolves.toMatchObject({
      totalKobo: 95_000,
    });
    expect(orders[0]?.totalKobo).toBe(80_000);
    expect(order.totalKobo).toBe(80_000);
  });

  it('does not let a client total replace the calculated amount due', async () => {
    const { service, orders } = serviceWith();
    const tampered = { ...local, totalKobo: 1 } as QuoteRequest;

    const order = await place(service, tampered);

    expect(order.totalKobo).toBe(80_000);
    expect(orders[0]?.totalKobo).toBe(80_000);
  });

  it('stores an agreed manual price without adding it to component amounts', async () => {
    const { service, orders } = serviceWith();
    const pending = await place(service, {
      service: 'special_pickup',
      pickup: samplePoint('igbesa'),
      destination: samplePoint('igbesa'),
      collection: samplePoint('ketu'),
    });
    expect(pending.totalKobo).toBeNull();
    expect(pending.components[0]).toMatchObject({ amountKobo: 80_000 });

    const quoted = await service.applyManualQuote(pending.id, 200_000, admin);

    expect(quoted).toMatchObject({
      pricingStatus: 'manual_quoted',
      totalKobo: 200_000,
    });
    expect(quoted.components[0]).toMatchObject({ amountKobo: 80_000 });
    expect(quoted.components[1]).toMatchObject({ amountKobo: null });

    await service.updateRule(
      'standard_zone',
      'A',
      {
        ...automatic,
        amountKobo: 100,
      },
      admin,
    );
    await expect(service.quote(local)).resolves.toMatchObject({
      totalKobo: 100,
    });
    expect(orders[0]).toMatchObject({
      totalKobo: 200_000,
      components: [
        expect.objectContaining({ amountKobo: 80_000 }),
        expect.objectContaining({ amountKobo: null }),
      ],
    });
  });

  it('refuses to reprice an order that already has an amount due', async () => {
    const { service } = serviceWith();
    const order = await place(service, local);

    await expect(
      service.applyManualQuote(order.id, 500_000, admin),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a second manual quote', async () => {
    const { service } = serviceWith();
    const pending = await place(service, {
      service: 'errand',
      errandTier: 'complex',
    });
    await service.applyManualQuote(pending.id, 150_000, admin);

    await expect(
      service.applyManualQuote(pending.id, 180_000, admin),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns not found for an unknown order or rule', async () => {
    const { service } = serviceWith();

    await expect(
      service.applyManualQuote('missing', 150_000, admin),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.updateRule(
        'errand',
        'missing',
        {
          quoteMode: 'manual',
          amountKobo: null,
          minimumKobo: 100_000,
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports a broken price list as unavailable', async () => {
    const { service } = serviceWith([]);
    await expect(service.quote(local)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('rejects an errand delivery that names only one end', async () => {
    const { service } = serviceWith();
    await expect(
      service.quote({
        service: 'errand',
        errandTier: 'simple',
        pickup: samplePoint('igbesa'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a manual quote that is not a positive whole kobo amount', async () => {
    const { service, orders } = serviceWith();
    const pending = await place(service, {
      service: 'errand',
      errandTier: 'complex',
    });

    await expect(
      service.applyManualQuote(pending.id, 0, admin),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.applyManualQuote(pending.id, 10.5, admin),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(orders[0]?.totalKobo).toBeNull();
  });

  it('turns a standard zone into a manual quote without an app change', async () => {
    const { service } = serviceWith();
    await service.updateRule(
      'standard_zone',
      'A',
      {
        quoteMode: 'manual',
        amountKobo: null,
        minimumKobo: 90_000,
      },
      admin,
    );

    await expect(service.quote(local)).resolves.toMatchObject({
      pricingStatus: 'pending_manual_quote',
      totalKobo: null,
      minimumTotalKobo: 90_000,
    });
  });

  it('prices Igbesa to Ketu from the map at the cross-zone fare', async () => {
    const { service } = serviceWith();

    await expect(
      service.quote({
        service: 'standard',
        pickup: samplePoint('igbesa'),
        destination: samplePoint('ketu'),
      }),
    ).resolves.toMatchObject({
      totalKobo: 130_000,
      pickupPlace: 'igbesa',
      destinationPlace: 'ketu',
    });
  });

  it('refuses a manual quote below the snapshotted floor', async () => {
    const { service, orders } = serviceWith();
    const pending = await place(service, {
      service: 'standard',
      pickup: samplePoint('igbesa'),
      destination: samplePoint('extended'),
    });
    expect(pending).toMatchObject({
      pricingStatus: 'pending_manual_quote',
      totalKobo: null,
      minimumTotalKobo: 150_000,
      destinationPlace: 'extended',
    });

    await expect(
      service.applyManualQuote(pending.id, 1, admin),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.applyManualQuote(pending.id, 149_900, admin),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(orders[0]?.totalKobo).toBeNull();

    await expect(
      service.applyManualQuote(pending.id, 150_000, admin),
    ).resolves.toMatchObject({ totalKobo: 150_000 });
  });

  it('keeps an order floor when operations raises the minimum', async () => {
    const { service } = serviceWith();
    const pending = await place(service, {
      service: 'errand',
      errandTier: 'complex',
    });

    await service.updateRule(
      'errand',
      'complex',
      {
        quoteMode: 'manual',
        amountKobo: null,
        minimumKobo: 250_000,
      },
      admin,
    );

    await expect(
      service.applyManualQuote(pending.id, 100_000, admin),
    ).resolves.toMatchObject({ totalKobo: 100_000 });
    await expect(
      service.quote({ service: 'errand', errandTier: 'complex' }),
    ).resolves.toMatchObject({ minimumTotalKobo: 250_000 });
  });

  it('does not price from a map that leaves a town uncovered', async () => {
    const { service } = serviceWith(APPROVED_PRICE_RULES, []);
    await expect(service.quote(local)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});
