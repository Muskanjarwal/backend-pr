export type Role = "patient" | "doctor" | "admin";

export interface Actor {
  id: string;
  role: Role;
}

/** Request-scoped facts every service needs for audit trails. */
export interface Ctx {
  actor: Actor;
  ip?: string;
  requestId?: string;
}

export type Permission =
  | "doctor:search"
  | "doctor:profile:update"
  | "slot:read"
  | "slot:manage"
  | "consultation:book"
  | "consultation:read"
  | "consultation:cancel"
  | "consultation:run"
  | "prescription:write"
  | "prescription:read"
  | "payment:read"
  | "admin:users"
  | "admin:doctors"
  | "admin:audit"
  | "admin:analytics";

// Role → permission matrix. Permission grants *capability*; ownership (is this MY consultation?) is enforced in the
// service layer, so a missing check there can't be papered over by a permissive role.
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  patient: new Set<Permission>(["doctor:search", "slot:read", "consultation:book", "consultation:read", "consultation:cancel", "prescription:read", "payment:read"]),
  doctor: new Set<Permission>(["doctor:search", "doctor:profile:update", "slot:read", "slot:manage", "consultation:read", "consultation:cancel", "consultation:run", "prescription:write", "prescription:read"]),
  admin: new Set<Permission>(["doctor:search", "slot:read", "consultation:read", "consultation:cancel", "prescription:read", "payment:read", "admin:users", "admin:doctors", "admin:audit", "admin:analytics"]),
};

export const can = (role: Role, p: Permission): boolean => ROLE_PERMISSIONS[role].has(p);
