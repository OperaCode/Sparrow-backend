import type { AccountStatus, Role } from '../../types/auth.js';

export const COMMUNITIES = ['igbesa', 'lusada', 'ketu'] as const;
export type Community = (typeof COMMUNITIES)[number];

export const ACCOUNT_TYPES = ['standard', 'business'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Roles an admin may assign. A rider has no login in V1. */
export const PROVISION_ROLES = ['customer', 'admin'] as const;
export type ProvisionRole = (typeof PROVISION_ROLES)[number];

export const NAME_MAX_LENGTH = 80;

export const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export interface UserProfile {
  id: string;
  phone: string;
  name: string | null;
  community: Community | null;
  accountType: AccountType;
  role: Role;
  status: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfilePatch {
  name?: string;
  community?: Community;
  accountType?: AccountType;
}

export interface ProvisionInput {
  phone: string;
  role: ProvisionRole;
  name?: string;
  community?: Community;
  accountType?: AccountType;
}

/** Normalized row written by admin provisioning. Every field is explicit. */
export interface NewAccount {
  phone: string;
  role: ProvisionRole;
  name: string | null;
  community: Community | null;
  accountType: AccountType;
}
