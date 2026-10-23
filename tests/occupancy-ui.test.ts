import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the actual HTML renderer without a browser or a database. Every
// contact and source reference here is synthetic; no client import is copied.
const handlers = new Map<string, (event: unknown) => void>();
let dialog: { innerHTML: string; close(): void; showModal(): void; setAttribute(): void; addEventListener(): void } | null = null;
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  querySelector: () => dialog,
  addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
  createElement: () => ({ innerHTML: '', close() {}, showModal() {}, setAttribute() {}, addEventListener() {} }),
  body: { append: (value: typeof dialog) => { dialog = value; } }
} });
const ui = await import('../public/workspace/rental.js');
test.after(() => { if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document'); });

function fixture() {
  return {
    rooms: [{ id: 'demo-room-1', propertyId: 'demo-property-1', code: 'DEMO-R01', label: '', occupancy: 'vacant', historicalOccupants: [
      { tenantId: 'demo-tenant-1', period: '2026-10', source: 'October 2026 collection sheet', sourceReference: 'DEMO source <script>alert(1)</script>', currentOccupancyVerified: false }
    ] }],
    tenants: [{ id: 'demo-tenant-1', name: 'DEMO historical <img src=x>', phone: '', email: '', notes: 'DEMO snapshot contact' }, { id: 'demo-unlinked', name: 'DEMO unrelated contact' }],
    agreements: [] as { id: string; propertyId: string; roomId: string; tenantId: string; startDate: string; endDate: string | null; monthlyRentMinor: string; depositRequiredMinor: string; currency: string; dueTerms: string }[],
    dues: [], collections: [], history: [], summary: { totalRooms: 1, occupiedRooms: 0, vacantRooms: 1, currencies: [] }
  };
}
async function render(data: ReturnType<typeof fixture>, section = 'rooms') {
  const target = { innerHTML: '', querySelectorAll: () => [] };
  await ui.renderRental(target, { property: { id: 'demo-property-1', name: 'DEMO villa' }, section,
    api: { rentalRead: async () => ({ data }) }, signal: new AbortController().signal,
    isCurrent: () => true, verifyAccess: async () => true, onAccessLoss: async () => assert.fail('Unexpected access loss') });
  return target.innerHTML;
}

test('An imported room without a dated agreement is unverified, including legacy vacant responses', async () => {
  const data = fixture(), before = JSON.stringify(data);
  const html = await render(data);
  assert.match(html, /<span class="badge amber">Occupancy not verified<\/span>/);
  assert.match(html, /<span>Vacant rooms<\/span>[\s\S]*?<div class="metric-value">0<\/div>/);
  assert.match(html, /<span>Occupancy not verified<\/span>[\s\S]*?<div class="metric-value">1<\/div>/);
  assert.doesNotMatch(html, /<span class="badge [^"]*">Vacant<\/span>/);
  assert.match(html, /Historical snapshot · October 2026/);
  assert.match(html, /DEMO historical &lt;img src=x&gt;/);
  assert.equal(JSON.stringify(data), before, 'Rendering cannot create agreements, dues or modify imported records');
});

test('Villa tenant screen includes historical snapshot contacts and excludes unrelated contacts', async () => {
  const html = await render(fixture(), 'tenants');
  const tenantTable = html.split('aria-label="Tenant register"')[1].split('</table>')[0];
  assert.match(tenantTable, /DEMO historical &lt;img src=x&gt;/);
  assert.doesNotMatch(tenantTable, /DEMO unrelated contact/);
  assert.match(html, /does not create an agreement or confirm current occupancy/);
});

test('Room history separates historical snapshot and dated agreements, escaping source references', async () => {
  await render(fixture());
  handlers.get('click')?.({ target: { closest: () => ({ dataset: { rentalAction: 'room-history', id: 'demo-room-1' } }) } });
  assert.ok(dialog);
  assert.match(dialog.innerHTML, /aria-label="Historical occupancy snapshots"/);
  assert.match(dialog.innerHTML, /October 2026/);
  assert.match(dialog.innerHTML, /DEMO source &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(dialog.innerHTML, /<script>|<img/);
  assert.match(dialog.innerHTML, /aria-label="Previous room occupants"/);
});

test('A real dated agreement can show occupied while historical-only and future agreements cannot', () => {
  const data = fixture();
  assert.equal(ui.occupancyStatus(data, data.rooms[0]), 'unknown');
  data.agreements.push({ id: 'demo-agreement', propertyId: 'demo-property-1', roomId: 'demo-room-1', tenantId: 'demo-tenant-1', startDate: '2000-01-01', endDate: '2099-12-31', monthlyRentMinor: '10000', depositRequiredMinor: '0', currency: 'QAR', dueTerms: 'DEMO explicit terms' });
  assert.equal(ui.occupancyStatus(data, data.rooms[0]), 'occupied');
  data.agreements[0].endDate = '2000-12-31';
  assert.equal(ui.occupancyStatus(data, data.rooms[0]), 'unknown');
  data.agreements[0].startDate = '2099-01-01'; data.agreements[0].endDate = null;
  assert.equal(ui.occupancyStatus(data, data.rooms[0]), 'unknown');
});

test('Isolated DEMO marker is presentation-only and cannot activate on hosted or lookalike hostnames', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(ui.isIsolatedDemoContext(host, 'isolated-local'), true);
  for (const host of ['hamdee.vercel.app', '127.0.0.1.example.com', 'localhost.example.com', '']) assert.equal(ui.isIsolatedDemoContext(host, 'isolated-local'), false);
  assert.equal(ui.isIsolatedDemoContext('localhost', undefined), false);
  assert.equal(ui.isIsolatedDemoContext('localhost', 'true'), false);
});

test('A conflicting historical source is held visibly rather than choosing an occupant', async () => {
  const data = fixture();
  data.rooms[0].historicalOccupants = [];
  Object.assign(data.rooms[0], { historicalOccupancyReviewRequired: true });
  const html = await render(data);
  assert.match(html, /Historical source needs review/);
  assert.match(html, /Occupancy not verified/);
});
