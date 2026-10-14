export const capabilities = {
  admin: ['read','create','update','archive','restore','audit'],
  operations: ['read','create','update'],
  finance: ['read','audit'],
  read_only: ['read']
} as const;
export type Role = keyof typeof capabilities;
export type Capability = 'read'|'create'|'update'|'archive'|'restore'|'audit';
export interface Grant { id: string; role: Role; portfolio: boolean }
export function permits(grant: Grant, action: Capability): boolean {
  return (capabilities[grant.role] as readonly string[]).includes(action);
}
