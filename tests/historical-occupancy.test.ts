import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { historicalOccupantsByRoom, sourceRoomReferences } from '../src/historical-occupancy';
import { createOwnerQaFixture } from './support/owner-crm-harness';

const note = (property = 'DEMO Villa', code = 'A1') =>
  `October2026 source snapshot only. Occupancy and agreement terms unverified. ${property} / ${code} (SL 1, PDF p1; AMOUNT=900; R DATE=5)`;
const properties = [{ id: 'p1', name: 'DEMO Villa' }, { id: 'p2', name: 'DEMO Other' }];
const rooms = [{ id: 'r1', property_id: 'p1', code: 'A1' }, { id: 'r2', property_id: 'p2', code: 'A1' }];

test('historical provenance links only the unique property and room, never a global room code', () => {
  const projected = historicalOccupantsByRoom(properties, rooms, [{ id: 't1', notes: note() }]);
  assert.equal(projected.size, 1);
  assert.deepEqual(projected.get('r1')?.historicalOccupants, [{ tenantId: 't1', period: '2026-10',
    source: 'October 2026 collection sheet', sourceReference: 'SL 1, PDF p1', confidence: 'source-reference-only', currentOccupancyVerified: false }]);
  assert.equal(projected.has('r2'), false);
});
test('placeholder or nationality-only contact labels never become named historical occupants', () => {
  for (const name of ['EMPTY', 'Vacant', 'Nepali', 'N/A']) {
    assert.deepEqual(historicalOccupantsByRoom(properties, rooms, [{ id: 't1', name, notes: note() }]).get('r1'),
      { historicalOccupants: [], historicalOccupancyReviewRequired: true });
  }
});
test('provenance parser accepts only complete known import grammar and excludes raw annotation text', () => {
  assert.equal(sourceRoomReferences(note() + '. Raw tenant field: DEMO / A2 (SL 2, PDF p2; AMOUNT=2; R DATE=3)').length, 1);
  for (const input of [undefined, 'notes ' + note(), note() + ' mixed unverified room', 'DEMO Villa / A1',
    note().replace('October2026', 'October2025'), note().replace('PDF p1', 'PDF p0')]) {
    assert.deepEqual(sourceRoomReferences(input), []);
  }
  assert.equal(sourceRoomReferences(note() + '; ' + note('DEMO Other').split('unverified. ')[1]).length, 2);
});
test('ambiguous property names, room identifiers or distinct occupant references cannot select a tenant', () => {
  assert.equal(historicalOccupantsByRoom([...properties, { id: 'p3', name: 'demo villa' }], rooms,
    [{ id: 't1', notes: note() }]).size, 0);
  assert.equal(historicalOccupantsByRoom(properties, [...rooms, { id: 'r3', property_id: 'p1', code: 'a1' }],
    [{ id: 't1', notes: note() }]).size, 0);
  const result = historicalOccupantsByRoom(properties, rooms, [{ id: 't1', notes: note() }, { id: 't2', notes: note() }]);
  assert.deepEqual(result.get('r1'), { historicalOccupants: [], historicalOccupancyReviewRequired: true });
});
test('owner API exposes saved historical source references without creating agreements, dues or present vacancy', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login();
  const write = async (route: string, data: unknown) => {
    const response = await f.request('POST', '/api/hamdee/v1/' + route, data, { 'Idempotency-Key': randomUUID() });
    assert.ok([200, 201].includes(response.status)); return (await response.json()).data;
  };
  const property = await write('properties', { name: 'DEMO Villa' });
  const room = await write('rental', { action: 'create-room', propertyId: property.id, code: 'A1', label: 'DEMO room' });
  const tenant = await write('rental', { action: 'create-tenant', name: 'DEMO Historical occupant', notes: note() });
  for (const asOf of ['2026-10-15', '2027-01-01']) {
    const response = await f.request('GET', `/api/hamdee/v1/rental?month=2026-10&asOf=${asOf}&propertyId=${property.id}`);
    assert.equal(response.status, 200); const state = (await response.json()).data;
    assert.equal(state.rooms[0].id, room.id); assert.equal(state.rooms[0].occupancy, 'unknown');
    assert.equal(state.rooms[0].historicalOccupants[0].tenantId, tenant.id);
    assert.equal(state.summary.vacantRooms, 0); assert.equal(state.summary.unverifiedRooms, 1);
    assert.equal(state.agreements.length, 0); assert.equal(state.dues.length, 0); assert.equal(state.collections.length, 0);
  }
  const renamed = await f.request('PATCH', `/api/hamdee/v1/properties/${property.id}`, { name: 'DEMO renamed villa' },
    { 'Idempotency-Key': randomUUID(), 'X-Hamdee-Property-Revision': `"property:${property.id}:1"` });
  assert.equal(renamed.status, 200);
  await write('rental', { action: 'update-room', roomId: room.id, expectedVersion: 1, code: 'RENAMED', label: 'DEMO renamed room' });
  await write('rental', { action: 'update-tenant', tenantId: tenant.id, expectedVersion: 1, name: 'DEMO renamed contact', notes: 'Owner edited contact notes' });
  const afterEdit = await f.request('GET', `/api/hamdee/v1/rental?month=2026-10&asOf=2027-01-01&propertyId=${property.id}`);
  const edited = (await afterEdit.json()).data;
  assert.equal(edited.rooms[0].code, 'RENAMED');
  assert.equal(edited.rooms[0].historicalOccupants[0].tenantId, tenant.id);
  assert.equal(edited.rooms[0].occupancy, 'unknown');
  assert.equal((await f.auth('POST', 'logout', {})).status, 200);
  const denied = await f.request('GET', '/api/hamdee/v1/rental?month=2026-10&asOf=2026-10-15');
  assert.equal(denied.status, 401);
});
