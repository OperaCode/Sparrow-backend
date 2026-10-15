import { z } from 'zod';
import {
  ERRAND_TIERS,
  MAX_AMOUNT_NAIRA,
  PLACES,
  PRICING_COMPONENTS,
  QUOTE_MODES,
} from './pricing.types.js';

const placeSchema = z.enum(PLACES);
const amountSchema = z.number().int().positive().max(MAX_AMOUNT_NAIRA);

/**
 * Places and service only. A client total, role, or customer id is rejected
 * rather than ignored, so it cannot become the amount due.
 */
export const quoteBodySchema = z
  .discriminatedUnion('service', [
    z.strictObject({
      service: z.literal('standard'),
      pickup: placeSchema,
      destination: placeSchema,
    }),
    z.strictObject({
      service: z.literal('special_pickup'),
      pickup: placeSchema,
      destination: placeSchema,
      collection: placeSchema,
    }),
    z.strictObject({
      service: z.literal('errand'),
      errandTier: z.enum(ERRAND_TIERS),
      pickup: placeSchema.optional(),
      destination: placeSchema.optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.service !== 'errand') return;
    if ((value.pickup === undefined) !== (value.destination === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Pickup and destination are both required when an errand includes delivery',
        path: ['destination'],
      });
    }
  });

export const updateRuleBodySchema = z
  .strictObject({
    quoteMode: z.enum(QUOTE_MODES),
    amountNaira: amountSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.quoteMode === 'automatic' && value.amountNaira === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'An automatic price requires an amount',
        path: ['amountNaira'],
      });
    }
    if (value.quoteMode === 'manual' && value.amountNaira !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A manual tier cannot carry an automatic amount',
        path: ['amountNaira'],
      });
    }
  })
  .transform((value) => ({
    quoteMode: value.quoteMode,
    amountNaira:
      value.quoteMode === 'automatic' ? (value.amountNaira ?? null) : null,
  }));

export const manualQuoteBodySchema = z.strictObject({
  amountNaira: amountSchema,
});

export const ruleParamsSchema = z.strictObject({
  component: z.enum(PRICING_COMPONENTS),
  tier: z.string().trim().min(1).max(32),
});

export const orderParamsSchema = z.strictObject({
  id: z.uuid(),
});
