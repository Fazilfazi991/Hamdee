import { requireThat } from './errors';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Profile { name: string; location: string|null; counterpartyId: string|null }
export function metadata(value: unknown, create: boolean): Partial<Profile> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 422, 'INVALID_METADATA', 'Enter a property profile.');
  const input = value as Record<string, unknown>;
  requireThat(Object.keys(input).length > 0 && Object.keys(input).every(k => ['name','location','counterpartyId'].includes(k)),
    422, 'INVALID_METADATA', 'Only property name, location and counterparty reference may be submitted.');
  const result: Partial<Profile> = {};
  for (const key of ['name','location'] as const) {
    if (!(key in input)) continue;
    const raw = input[key];
    requireThat((key !== 'name' && raw === null) || typeof raw === 'string', 422, 'INVALID_METADATA', 'Check the property text fields.');
    const text = typeof raw === 'string' ? raw.trim() : null;
    requireThat((key !== 'name' || !!text) && (!text || text.length <= (key === 'name' ? 200 : 500)), 422, 'INVALID_METADATA', 'Check the property text lengths.');
    if(key==='name')result.name=text!;else result.location=text||null;
  }
  if ('counterpartyId' in input) {
    requireThat(input.counterpartyId === null || (typeof input.counterpartyId === 'string' && uuid.test(input.counterpartyId)),
      422, 'INVALID_COUNTERPARTY', 'Select a valid counterparty reference.');
    result.counterpartyId = input.counterpartyId as string|null;
  }
  requireThat(!create || result.name, 422, 'INVALID_METADATA', 'Enter a property name.');
  return result;
}
export function archiveReason(value: unknown): string {
  requireThat(value && typeof value === 'object' && !Array.isArray(value),422,'INVALID_REASON','Enter a reason.');
  const input = value as Record<string,unknown>;
  requireThat(Object.keys(input).length === 1 && typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.trim().length <= 500,
    422,'INVALID_REASON','Enter a reason of at most 500 characters.');
  return input.reason.trim();
}
