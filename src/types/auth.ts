export const ROLES = ['customer', 'rider', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type AccountStatus = 'active' | 'suspended';

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
