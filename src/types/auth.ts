export const ROLES = ['customer', 'rider', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_STATUSES = ['active', 'suspended', 'deactivated'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The identity attached to a request after authentication succeeds. */
export interface AuthContext {
  userId: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
