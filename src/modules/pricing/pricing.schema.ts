import { z } from 'zod';
import {
  ERRAND_TIERS,
  MAX_AMOUNT_KOBO,
  PRICING_COMPONENTS,
  QUOTE_MODES,
  SERVICE_AREA_PLACES,
} from './pricing.types.js';

const amountSchema = z.number().int().positive().max(MAX_AMOUNT_KOBO);

const coordinateSchema = z.strictObject({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

/**
 * Coordinates and service only. A community name, zone, or client total is
 * rejected rather than ignored, so it cannot choose the fare.
 */
export const quoteBodySchema = z
  .discriminatedUnion('service', [
    z.strictObject({
      service: z.literal('standard'),
      pickup: coordinateSchema,
      destination: coordinateSchema,
    }),
    z.strictObject({
      service: z.literal('special_pickup'),
      pickup: coordinateSchema,
      destination: coordinateSchema,
      collection: coordinateSchema,
    }),
    z.strictObject({
      service: z.literal('errand'),
      errandTier: z.enum(ERRAND_TIERS),
      pickup: coordinateSchema.optional(),
      destination: coordinateSchema.optional(),
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
    amountKobo: amountSchema.optional(),
    minimumKobo: amountSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.quoteMode === 'automatic' && value.amountKobo === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'An automatic price requires an amount',
        path: ['amountKobo'],
      });
    }
    if (value.quoteMode === 'automatic' && value.minimumKobo !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'An automatic price cannot carry a manual floor',
        path: ['minimumKobo'],
      });
    }
    if (value.quoteMode === 'manual' && value.minimumKobo === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A manual tier requires a minimum amount',
        path: ['minimumKobo'],
      });
    }
    if (value.quoteMode === 'manual' && value.amountKobo !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A manual tier cannot carry an automatic amount',
        path: ['amountKobo'],
      });
    }
  })
  .transform((value) => ({
    quoteMode: value.quoteMode,
    amountKobo:
      value.quoteMode === 'automatic' ? (value.amountKobo ?? null) : null,
    minimumKobo:
      value.quoteMode === 'manual' ? (value.minimumKobo ?? null) : null,
  }));

const latitudeSchema = z.number().gte(-90).lte(90);
const longitudeSchema = z.number().gte(-180).lte(180);

export const areaBodySchema = z
  .strictObject({
    minLatitude: latitudeSchema,
    maxLatitude: latitudeSchema,
    minLongitude: longitudeSchema,
    maxLongitude: longitudeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.minLatitude >= value.maxLatitude) {
      ctx.addIssue({
        code: 'custom',
        message: 'Latitude minimum must be below its maximum',
        path: ['maxLatitude'],
      });
    }
    if (value.minLongitude >= value.maxLongitude) {
      ctx.addIssue({
        code: 'custom',
        message: 'Longitude minimum must be below its maximum',
        path: ['maxLongitude'],
      });
    }
  });

export const areaParamsSchema = z.strictObject({
  place: z.enum(SERVICE_AREA_PLACES),
});

export const manualQuoteBodySchema = z.strictObject({
  amountKobo: amountSchema,
});

export const ruleParamsSchema = z.strictObject({
  component: z.enum(PRICING_COMPONENTS),
  tier: z.string().trim().min(1).max(32),
});

export const orderParamsSchema = z.strictObject({
  id: z.uuid(),
});
