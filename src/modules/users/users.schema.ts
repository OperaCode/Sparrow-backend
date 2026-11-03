import { z } from 'zod';
import { ACCOUNT_STATUSES } from '../../types/auth.js';
import {
  ACCOUNT_TYPES,
  COMMUNITIES,
  NAME_MAX_LENGTH,
  PHONE_PATTERN,
  PROVISION_ROLES,
} from './users.types.js';

const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);
const communitySchema = z.enum(COMMUNITIES);
const accountTypeSchema = z.enum(ACCOUNT_TYPES);

/**
 * Own-profile fields only. Role, phone, status, and id are rejected rather
 * than ignored, so a client cannot smuggle authority into the body.
 */
export const profileBodySchema = z
  .strictObject({
    name: nameSchema.optional(),
    community: communitySchema.optional(),
    accountType: accountTypeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.name === undefined &&
      value.community === undefined &&
      value.accountType === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one profile field is required',
        path: [],
      });
    }
  });

export const emptyBodySchema = z.strictObject({});

export const provisionBodySchema = z.strictObject({
  phone: z.string().regex(PHONE_PATTERN, 'Phone must be in E.164 form'),
  role: z.enum(PROVISION_ROLES),
  name: nameSchema.optional(),
  community: communitySchema.optional(),
  accountType: accountTypeSchema.optional(),
});

export const userParamsSchema = z.strictObject({
  id: z.uuid(),
});

export const statusBodySchema = z.strictObject({
  status: z.enum(ACCOUNT_STATUSES),
});

export const roleBodySchema = z.strictObject({
  role: z.enum(PROVISION_ROLES),
});
