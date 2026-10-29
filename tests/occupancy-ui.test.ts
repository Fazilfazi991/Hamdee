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

test('Owner-confirmed occupancy and vacancy do not require an agreement document', async () => {
  const data = fixture();
  const room = data.rooms[0] as typeof data.rooms[0] & {occupancyConfirmation: unknown; currentTenantId: string; occupancyVersion: number};
  room.occupancy = 'occupied';
  room.currentTenantId = 'demo-tenant-1';
  room.occupancyVersion = 1;
  room.occupancyConfirmation = {status:'occupied',tenantId:room.currentTenantId,internalAgreementId:null};
  assert.equal(ui.occupancyStatus(data, room), 'occupied');
  const html = await render(data);
  assert.match(html, /<span class="badge green">Occupied<\/span>/);
  assert.match(html, /DEMO historical &lt;img src=x&gt;/);
  assert.match(html, /Change tenant/);
  assert.match(html, /Collect rent/);
  room.occupancy = 'vacant';
  assert.equal(ui.occupancyStatus(data, room), 'vacant');
  assert.equal(data.agreements.length, 0);
});

test('New rental terms use QAR while existing tenant terms retain their saved currency', () => {
  const existing = {tenantId:'synthetic-tenant',currency:'INR'};
  assert.equal(ui.confirmedTermsCurrency(existing,'synthetic-tenant'),'INR');
  assert.equal(ui.confirmedTermsCurrency(existing,'another-tenant'),'QAR');
  assert.equal(ui.confirmedTermsCurrency(null,'synthetic-tenant'),'QAR');
});

test('Villa tenant screen includes historical snapshot contacts and excludes unrelated contacts', async () => {
  const html = await render(fixture(), 'tenants');
  const tenantTable = html.split('aria-label="Tenant register"')[1].split('</table>')[0];
  assert.match(tenantTable, /DEMO historical &lt;img src=x&gt;/);
  assert.doesNotMatch(tenantTable, /DEMO unrelated contact/);
  assert.doesNotMatch(tenantTable, /DEMO snapshot contact|<th>Notes<\/th>/);
  assert.match(tenantTable, /Edit tenant/);
  assert.match(html, /does not establish current occupancy/);
});

test('An owner-confirmed October source is labelled without asserting current occupancy', async () => {
  const data = {...fixture(),sourceConfirmations:[{tenantId:'demo-tenant-1',period:'2026-10'}]};
  const html = await render(data, 'tenants');
  const tenantTable = html.split('aria-label="Tenant register"')[1].split('</table>')[0];
  assert.match(tenantTable, /October 2026 · owner confirmed/);
  assert.equal(ui.occupancyStatus(data, data.rooms[0]), 'unknown');
});

test('Room history keeps historical occupants while hiding raw source references', async () => {
  await render(fixture());
  handlers.get('click')?.({ target: { closest: () => ({ dataset: { rentalAction: 'room-history', id: 'demo-room-1' } }) } });
  assert.ok(dialog);
  assert.match(dialog.innerHTML, /aria-label="Historical occupancy snapshots"/);
  assert.match(dialog.innerHTML, /October 2026/);
  assert.match(dialog.innerHTML, /October 2026 collection sheet/);
  assert.doesNotMatch(dialog.innerHTML, /DEMO source|sourceReference/);
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

test('Isolated DEMO marker requires an exact local or approved hosted origin', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(ui.isIsolatedDemoContext(host, 'isolated-local'), true);
  for (const host of ['hamdee.vercel.app', '127.0.0.1.example.com', 'localhost.example.com', '']) assert.equal(ui.isIsolatedDemoContext(host, 'isolated-local'), false);
  assert.equal(ui.isIsolatedDemoContext('localhost', undefined), false);
  assert.equal(ui.isIsolatedDemoContext('localhost', 'true'), false);
  const hosted='hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app';
  assert.equal(ui.isIsolatedDemoContext(hosted,'isolated-hosted-demo'),true);
  for (const marker of [undefined,'','true','isolated-local']) assert.equal(ui.isIsolatedDemoContext(hosted,marker),false);
  for (const host of ['hamdee.vercel.app','localhost',`evil-${hosted}`,`${hosted}.example.com`,'']) assert.equal(ui.isIsolatedDemoContext(host,'isolated-hosted-demo'),false);
});

test('A conflicting historical source is held visibly rather than choosing an occupant', async () => {
  const data = fixture();
  data.rooms[0].historicalOccupants = [];
  Object.assign(data.rooms[0], { historicalOccupancyReviewRequired: true });
  const html = await render(data);
  assert.match(html, /Historical source needs review/);
  assert.match(html, /Occupancy not verified/);
});
