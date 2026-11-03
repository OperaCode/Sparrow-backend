import { z } from 'zod';
import { listQuerySchema } from '../../http/pagination.js';
import {
  ERRAND_TIERS,
  MAX_AMOUNT_KOBO,
  PRICING_COMPONENTS,
  QUOTE_MODES,
  SERVICE_AREA_PLACES,
} from './pricing.types.js';

const SERVICE_TYPES = ['standard', 'special_pickup', 'errand'] as const;

/** Same E.164 rule as a user phone. A collection contact is not an account. */
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;

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

/**
 * Special Pickup collection. The coordinate is classified for the fee. The
 * address and contact are the third-party stop, and are not a zone name.
 */
const collectionStopSchema = z.strictObject({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  address: z.string().trim().min(1).max(200),
  landmark: z.string().trim().min(1).max(120).optional(),
  contactName: z.string().trim().min(1).max(80),
  contactPhone: z.string().regex(PHONE_PATTERN, 'Phone must be in E.164 form'),
});

/**
 * Order create. Standard Delivery and Errand stay coordinate or task bodies.
 * Special Pickup requires its own collection stop, so a delivery pickup cannot
 * stand in for the third party and an errand cannot be priced as one.
 */
export const createOrderBodySchema = z
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
      collection: collectionStopSchema,
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

export const ordersListQuerySchema = listQuerySchema({
  serviceType: z.enum(SERVICE_TYPES).optional(),
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
