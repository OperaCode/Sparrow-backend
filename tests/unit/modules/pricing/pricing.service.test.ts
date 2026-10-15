import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../../src/lib/logger.js';
import { APPROVED_PRICE_RULES } from '../../../../src/modules/pricing/pricing.catalog.js';
import type {
  CreatePricedOrderArgs,
  ManualQuoteWriteResult,
  PricingRepository,
} from '../../../../src/modules/pricing/pricing.repository.js';
import { createPricingService } from '../../../../src/modules/pricing/pricing.service.js';
import type {
  PriceRuleRecord,
  PricedOrder,
  QuoteInput,
  RuleUpdate,
} from '../../../../src/modules/pricing/pricing.types.js';

interface Memory {
  repository: PricingRepository;
  orders: PricedOrder[];
}

function memoryRepository(initial: readonly PriceRuleRecord[]): Memory {
  const rules = initial.map((rule) => ({ ...rule }));
  const orders: PricedOrder[] = [];

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
      rule.amountNaira = patch.amountNaira;
      return Promise.resolve({ ...rule });
    },

    createPricedOrder({ input, quoteFromRules }: CreatePricedOrderArgs) {
      const quote = quoteFromRules(rules.map((rule) => ({ ...rule })));
      const order: PricedOrder = {
        id: `order-${orders.length + 1}`,
        serviceType: input.service,
        pricingStatus: quote.pricingStatus,
        currency: 'NGN',
        components: quote.components.map((component) => ({ ...component })),
        totalNaira: quote.totalNaira,
      };
      orders.push(order);
      return Promise.resolve({
        ...order,
        components: order.components.map((component) => ({ ...component })),
      });
    },

    findOrder(id) {
      const order = orders.find((item) => item.id === id);
      if (order === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ...order,
        components: order.components.map((component) => ({ ...component })),
      });
    },

    applyManualQuote(id, amountNaira): Promise<ManualQuoteWriteResult> {
      const order = orders.find((item) => item.id === id);
      if (order === undefined) return Promise.resolve('missing');
      if (order.pricingStatus !== 'pending_manual_quote') {
        return Promise.resolve('not_pending');
      }
      order.pricingStatus = 'manual_quoted';
      order.totalNaira = amountNaira;
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
) {
  const memory = memoryRepository(initial);
  const service = createPricingService({
    repository: memory.repository,
    logger: createLogger({ level: 'silent', nodeEnv: 'test' }),
  });
  return { ...memory, service };
}

const local: QuoteInput = {
  service: 'standard',
  pickup: 'igbesa',
  destination: 'igbesa',
};

describe('pricing service', () => {
  it('keeps a snapshotted total after the price list changes', async () => {
    const { service, orders } = serviceWith();
    const order = await service.createOrder('customer-1', local);
    expect(order.totalNaira).toBe(800);

    await service.updateRule('standard_zone', 'A', {
      quoteMode: 'automatic',
      amountNaira: 950,
    });

    await expect(service.quote(local)).resolves.toMatchObject({
      totalNaira: 950,
    });
    expect(orders[0]?.totalNaira).toBe(800);
    expect(order.totalNaira).toBe(800);
  });

  it('does not let a client total replace the calculated amount due', async () => {
    const { service, orders } = serviceWith();
    const tampered = { ...local, totalNaira: 1 } as QuoteInput;

    const order = await service.createOrder('customer-1', tampered);

    expect(order.totalNaira).toBe(800);
    expect(orders[0]?.totalNaira).toBe(800);
  });

  it('stores an agreed manual price without adding it to component amounts', async () => {
    const { service, orders } = serviceWith();
    const pending = await service.createOrder('customer-1', {
      service: 'special_pickup',
      pickup: 'igbesa',
      destination: 'igbesa',
      collection: 'ketu',
    });
    expect(pending.totalNaira).toBeNull();
    expect(pending.components[0]).toMatchObject({ amountNaira: 800 });

    const quoted = await service.applyManualQuote(pending.id, 2000, 'admin-1');

    expect(quoted).toMatchObject({
      pricingStatus: 'manual_quoted',
      totalNaira: 2000,
    });
    expect(quoted.components[0]).toMatchObject({ amountNaira: 800 });
    expect(quoted.components[1]).toMatchObject({ amountNaira: null });

    await service.updateRule('standard_zone', 'A', {
      quoteMode: 'automatic',
      amountNaira: 1,
    });
    await expect(service.quote(local)).resolves.toMatchObject({
      totalNaira: 1,
    });
    expect(orders[0]).toMatchObject({
      totalNaira: 2000,
      components: [
        expect.objectContaining({ amountNaira: 800 }),
        expect.objectContaining({ amountNaira: null }),
      ],
    });
  });

  it('refuses to reprice an order that already has an amount due', async () => {
    const { service } = serviceWith();
    const order = await service.createOrder('customer-1', local);

    await expect(
      service.applyManualQuote(order.id, 5000, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a second manual quote', async () => {
    const { service } = serviceWith();
    const pending = await service.createOrder('customer-1', {
      service: 'errand',
      errandTier: 'complex',
    });
    await service.applyManualQuote(pending.id, 1500, 'admin-1');

    await expect(
      service.applyManualQuote(pending.id, 1800, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns not found for an unknown order or rule', async () => {
    const { service } = serviceWith();

    await expect(
      service.applyManualQuote('missing', 1500, 'admin-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.updateRule('errand', 'missing', {
        quoteMode: 'manual',
        amountNaira: null,
      }),
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
        pickup: 'igbesa',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a manual quote that is not a positive whole naira amount', async () => {
    const { service, orders } = serviceWith();
    const pending = await service.createOrder('customer-1', {
      service: 'errand',
      errandTier: 'complex',
    });

    await expect(
      service.applyManualQuote(pending.id, 0, 'admin-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.applyManualQuote(pending.id, 10.5, 'admin-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(orders[0]?.totalNaira).toBeNull();
  });

  it('turns a standard zone into a manual quote without an app change', async () => {
    const { service } = serviceWith();
    await service.updateRule('standard_zone', 'A', {
      quoteMode: 'manual',
      amountNaira: null,
    });

    await expect(service.quote(local)).resolves.toMatchObject({
      pricingStatus: 'pending_manual_quote',
      totalNaira: null,
    });
  });
});
