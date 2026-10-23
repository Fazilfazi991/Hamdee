// Read-only projection of provenance already saved with imported contacts.
// A source-month reference is not a present-day tenancy, agreement or rent due.
type RecordRow = Record<string, unknown>;
export interface HistoricalOccupant {
  tenantId: string;
  period: '2026-10';
  source: 'October 2026 collection sheet';
  sourceReference: string;
  confidence: 'source-reference-only';
  currentOccupancyVerified: false;
}
const prefix = 'October2026 source snapshot only. Occupancy and agreement terms unverified. ';
const normalized = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
// Source placeholders identify neither a person nor a current tenancy. Keep the
// original contact untouched, but do not promote it into an occupant identity.
const unnamed = /^(?:EMPTY|VACANT|UNKNOWN|N\/?A|TENANT|INDIAN|INDIA|PAKISTANI|PAKISTAN|NEPALI|NEPAL|BANGLADESHI|BANGLADESH|SRI ?LANKA|SRI LANKAN|FILIPINO|PHILIPPINES|EGYPTIAN|SUDANESE|QATARI)$/;
export function sourceRoomReferences(notes: unknown) {
  if (typeof notes !== 'string' || !notes.startsWith(prefix)) return [];
  let body = notes.slice(prefix.length);
  const annotation = body.indexOf('). Raw tenant field:');
  if (annotation >= 0) body = body.slice(0, annotation + 1);
  const pattern = /([^;/()]+?) \/ ([^;/()]+?) \(SL (\d+), PDF p([1-9]\d*); AMOUNT=[^()]*?; R DATE=[^()]*?\)/g;
  const matches = [...body.matchAll(pattern)];
  // Do not salvage a plausible substring from a malformed or mixed reference.
  if (!matches.length || body.replace(pattern, '').replace(/[;.\s]/g, '')) return [];
  return matches.map(match => ({ property: normalized(match[1]), code: normalized(match[2]),
    sourceReference: `SL ${match[3]}, PDF p${match[4]}` }));
}
export function historicalOccupantsByRoom(properties: readonly RecordRow[], rooms: readonly RecordRow[], tenants: readonly RecordRow[]) {
  const propertyIds = new Map<string, string[]>();
  for (const property of properties) {
    const key = normalized(property.name), ids = propertyIds.get(key) ?? [];
    ids.push(String(property.id)); propertyIds.set(key, ids);
  }
  const roomIds = new Map<string, string[]>();
  for (const room of rooms) {
    const key = String(room.property_id) + ':' + normalized(room.code), ids = roomIds.get(key) ?? [];
    ids.push(String(room.id)); roomIds.set(key, ids);
  }
  const candidates = new Map<string, Map<string, HistoricalOccupant>>();
  const reviewRooms = new Set<string>();
  for (const tenant of tenants) for (const reference of sourceRoomReferences(tenant.notes)) {
    const property = propertyIds.get(reference.property);
    if (property?.length !== 1) continue;
    const room = roomIds.get(property[0] + ':' + reference.code);
    if (room?.length !== 1) continue;
    if (unnamed.test(normalized(tenant.name))) { reviewRooms.add(room[0]); continue; }
    const occupants = candidates.get(room[0]) ?? new Map<string, HistoricalOccupant>();
    occupants.set(String(tenant.id), { tenantId: String(tenant.id), period: '2026-10',
      source: 'October 2026 collection sheet', sourceReference: reference.sourceReference, confidence: 'source-reference-only', currentOccupancyVerified: false });
    candidates.set(room[0], occupants);
  }
  return new Map([...new Set([...candidates.keys(), ...reviewRooms])].map(roomId => {
    const occupants = candidates.get(roomId) ?? new Map<string, HistoricalOccupant>();
    return [roomId, {
    historicalOccupants: occupants.size === 1 && !reviewRooms.has(roomId) ? [...occupants.values()] : [],
    historicalOccupancyReviewRequired: occupants.size > 1 || reviewRooms.has(roomId)
  }]; }));
}
