// Isolated, synthetic PGlite profiling only. No URLs, secrets, hosted data or sockets.
// Run: node --import tsx scripts/profile-query-performance.mjs
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { carFixture, seedCarReceiptChoices } from '../tests/support/car-fixture.ts';
import { adapter } from '../tests/support/fixture.ts';
import { up, issuer } from '../tests/support/fixture.ts';
import { operationsMigration } from '../tests/support/operations-fixture.ts';
import { carMigration } from '../tests/support/car-fixture.ts';
import { inspectOwnerPortableRuntime, startOwnerNativeCluster } from '../tests/support/owner-crm-harness.ts';
import { LocalPostgresDatabase, localConnectionOptions } from '../src/database.ts';
import { PropertyService } from '../src/service.ts';
import { RentalService } from '../src/rental.ts';
import { ExpenseService } from '../src/expenses.ts';
import { CompanyFinanceService } from '../src/company-finance.ts';
import { StaffCollectionsService } from '../src/staff-collections.ts';
import { CarRentalService, combinedReceiptSourceReader } from '../src/car-rentals.ts';

const native = process.argv.includes('--native');
async function nativeFixture() {
  assert.ok(process.argv.includes('--approved-local-only'), 'Native profiling requires explicit disposable-local authorization');
  const tools = path.resolve('.test-tools');
  const runtime = await inspectOwnerPortableRuntime(path.join(tools, 'postgresql-17.11-5-windows-x64-binaries.zip'), path.join(tools, 'postgresql-17.11-5'));
  const cluster = await startOwnerNativeCluster(runtime, 'owner');
  const owner = new Pool({ ...localConnectionOptions(cluster.connection), max: 1 }); owner.on('error', () => {});
  let database;
  try {
    await owner.query(await up()); await owner.query(await operationsMigration()); await owner.query(await carMigration());
    const userId = randomUUID(), subject = randomUUID();
    await owner.query('INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$4,true)', [userId, issuer, subject, 'Synthetic profile owner']);
    await owner.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)", [randomUUID(), userId]);
    const password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await owner.query(`CREATE ROLE hamdee_profile_backend LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await owner.query('GRANT hamdee_runtime TO hamdee_profile_backend');
    const connection = new URL(cluster.connection); connection.username = 'hamdee_profile_backend'; connection.password = password;
    database = new LocalPostgresDatabase(connection.toString(), () => {});
    const identity = { issuer, subject }, properties = new PropertyService(database, identity);
    const rental = new RentalService(properties), staff = new StaffCollectionsService(properties, combinedReceiptSourceReader),
      finance = new CompanyFinanceService(properties, combinedReceiptSourceReader), cars = new CarRentalService(properties);
    const mutate = service => async body => (await service.mutate(identity, body, randomUUID(), randomUUID())).data;
    const writeCar = mutate(cars), writeStaff = mutate(staff), writeFinance = mutate(finance);
    const pg = { query: (text, values) => owner.query(text, values), transaction: async work => {
      const client = await owner.connect();
      try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }, close: async () => { await database.close(); await owner.end(); await cluster.close(); console.log('NATIVE_PROFILE_CLUSTER_STOPPED', cluster.evidence().serverStopped); } };
    return { pg, database, identity, properties, rental, users: { admin: { id: userId } },
      create: async (_user, name) => (await properties.mutate(identity, { action: 'create', key: randomUUID(), requestId: randomUUID(), body: { name } })).data,
      vehicle: () => writeCar({ action: 'create-vehicle', registration: 'PROFILE-' + randomUUID().slice(0, 8), make: 'Synthetic', model: 'Synthetic', status: 'active' }),
      agreement: (vehicleId, fields) => writeCar({ action: 'create-agreement', vehicleId, agreementKey: randomUUID(), customerName: 'Synthetic customer', customerContact: 'synthetic@example.invalid', agreedAmount: '1000', currency: 'XTS', billingPeriod: 'Explicit synthetic term', ...fields }),
      collector: () => writeStaff({ action: 'create-collector', name: 'Synthetic collector' }),
      account: () => writeFinance({ action: 'create-account', name: 'Synthetic account', scope: 'company', kind: 'cash', currency: 'XTS', openingDate: '2026-10-01', openingAmount: '0', ownerConfirmedOpening: true }),
      receipt: () => writeFinance({ action: 'create-classified-receipt', receiptKey: randomUUID(), classification: 'synthetic', receivedOn: '2026-10-15', amount: '100', currency: 'XTS', method: 'cash' }),
      collect: (collectorId, sourceId) => writeStaff({ action: 'record-collection', collectorId, sourceKind: 'classified-receipt', sourceId, disposition: 'collector-held', ownerConfirmedDisposition: true }),
      handover: (collectorId, accountId, fields) => writeStaff({ action: 'handover', collectorId, accountId, currency: 'XTS', reference: randomUUID(), ...fields }) };
  } catch (error) { await database?.close(); await owner.end(); await cluster.close(); throw error; }
}
const f = native ? await nativeFixture() : await carFixture();
try {
  const properties = await Promise.all(Array.from({ length: 8 }, (_, i) => f.create('admin', `Synthetic profile villa ${i}`)));
  const write = async body => (await f.rental.mutate(f.identity, body, randomUUID(), randomUUID())).data;
  const tenants = [];
  for (let i = 0; i < 115; i++) tenants.push(await write({ action: 'create-tenant', name: `Synthetic profile contact ${i}` }));
  const arrangements = [];
  for (let i = 0; i < 131; i++) {
    const property = properties[i % properties.length];
    const room = await write({ action: 'create-room', propertyId: property.id, code: `PROFILE-${i}` });
    const agreement = await write({ action: 'create-agreement', roomId: room.id, tenantId: tenants[i % tenants.length].id,
      startDate: '2026-01-01', endDate: null, monthlyRent: '100.00', currency: i % 2 ? 'XTS' : 'XXX', depositRequired: '0', dueTerms: 'Synthetic explicit monthly due' });
    arrangements.push({ property, room, agreement });
  }
  const rows = arrangements.flatMap(({ property, room, agreement }) => Array.from({ length: 12 }, (_, i) => ({
    property_id: property.id, room_id: room.id, agreement_id: agreement.id, currency: agreement.currency,
    period: `2026-${String(i + 1).padStart(2, '0')}`, date: `2026-${String(i + 1).padStart(2, '0')}-05`,
    due_id: randomUUID(), collection_id: randomUUID(), allocation_id: randomUUID(), event_id: randomUUID()
  })));
  // Direct fixture seeding retains database constraints/triggers. No production
  // migration or trigger disabling. Every inserted financial row has an event.
  await f.pg.transaction(async tx => {
    const input = JSON.stringify(rows);
    await tx.query(`INSERT INTO hamdee_private.rental_events(id,property_id,room_id,entity_id,action,detail,actor_id)
      SELECT event_id,property_id,room_id,due_id,'synthetic-profile','{}'::jsonb,$2 FROM jsonb_to_recordset($1::jsonb)
      AS r(event_id uuid,property_id uuid,room_id uuid,due_id uuid)`, [input, f.users.admin.id]);
    await tx.query(`INSERT INTO hamdee_private.rent_dues(id,agreement_id,room_id,property_id,currency,period,due_date,amount_minor,snapshot,event_id)
      SELECT due_id,agreement_id,room_id,property_id,currency,period,date,10000,'{}'::jsonb,event_id FROM jsonb_to_recordset($1::jsonb)
      AS r(due_id uuid,agreement_id uuid,room_id uuid,property_id uuid,currency text,period text,date date,event_id uuid)`, [input]);
    await tx.query(`INSERT INTO hamdee_private.rent_collections(id,agreement_id,room_id,property_id,currency,kind,method,amount_minor,received_date,status,event_id)
      SELECT collection_id,agreement_id,room_id,property_id,currency,'rent','cash',10000,date,'recorded',event_id FROM jsonb_to_recordset($1::jsonb)
      AS r(collection_id uuid,agreement_id uuid,room_id uuid,property_id uuid,currency text,date date,event_id uuid)`, [input]);
    await tx.query(`INSERT INTO hamdee_private.rent_allocations(id,collection_id,due_id,agreement_id,currency,amount_minor,allocated_date,event_id)
      SELECT allocation_id,collection_id,due_id,agreement_id,currency,10000,date,event_id FROM jsonb_to_recordset($1::jsonb)
      AS r(allocation_id uuid,collection_id uuid,due_id uuid,agreement_id uuid,currency text,date date,event_id uuid)`, [input]);
  });
  for (let i = 0; i < 12; i++) {
    const v = await f.vehicle(), a = await f.agreement(v.id, { startDate: '2026-01-01', endDate: '2026-12-31' });
    await seedCarReceiptChoices(f, a, 120);
  }
  const collector = await f.collector(), account = await f.account();
  for (let i = 0; i < 24; i++) {
    const receipt = await f.receipt();
    await f.collect(collector.id, receipt.id);
  }
  await f.handover(collector.id, account.id, { amount: '100', handedOn: '2026-10-16' });
  let queries = [];
  const base = f.database || adapter(f.pg);
  const counted = { transaction: work => base.transaction(sql => work({ query: async (text, params) => {
    const start = performance.now(); const result = await sql.query(text, params);
    queries.push({ ms: performance.now() - start, rows: result.rows.length, text, params }); return result;
  } })) };
  const p = new PropertyService(counted, f.identity);
  const rental = new RentalService(p), expenses = new ExpenseService(p), staff = new StaffCollectionsService(p, combinedReceiptSourceReader),
    finance = new CompanyFinanceService(p, combinedReceiptSourceReader), cars = new CarRentalService(p);
  const query = { month: '2026-11', asOf: '2026-11-30' };
  const cases = [ ['rental', () => rental.overview(f.identity, query)], ['property-rental', () => rental.overview(f.identity, { ...query, propertyId: properties[0].id })],
    ['expenses', () => expenses.overview(f.identity, query)], ['staff', () => staff.overview(f.identity, query)],
    ['finance', () => finance.overview(f.identity, query)], ['cars', () => cars.overview(f.identity, query)], ['dashboard', () => p.dashboard(f.identity)] ];
  const pct = (values, q) => +[...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1].toFixed(2);
  const results = [], expensive = [];
  for (const [name, run] of cases) {
    const samples = [], sql = []; let bytes = 0, count = 0;
    for (let i = 0; i < 11; i++) {
      queries = []; const start = performance.now(); const data = await run(); const ms = performance.now() - start;
      bytes = Buffer.byteLength(JSON.stringify(data)); count = queries.length;
      if (i > 0) { samples.push(ms); sql.push(queries.reduce((s, q) => s + q.ms, 0)); }
      if (name === 'rental') {
        assert.equal(data.summary.totalRooms, 131); assert.equal(data.tenants.length, 115);
        assert.equal(data.summary.currencies.length, 2);
        assert.equal(data.summary.currencies.reduce((s, x) => s + BigInt(x.dueMinor), 0n), 1310000n);
        assert.equal(data.summary.currencies.reduce((s, x) => s + BigInt(x.collectedMinor), 0n), 1310000n);
        assert.ok(data.summary.currencies.every(x => x.outstandingMinor === '0'));
      }
    }
    expensive.push({ name, query: [...queries].sort((a, b) => b.ms - a.ms)[0] });
    results.push({ module: name, queryCount: count, responseBytes: bytes, warmP50Ms: pct(samples, .5), warmP75Ms: pct(samples, .75), warmP95Ms: pct(samples, .95), sqlP50Ms: pct(sql, .5) });
  }
  const plans = [];
  if (native) for (const { name, query: measured } of expensive.filter(x => ['rental', 'expenses', 'cars'].includes(x.name))) {
    const explain = await p.ownerContext(f.identity, async sql => (await sql.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + measured.text, measured.params)).rows[0]['QUERY PLAN'][0]);
    const nodes = []; const visit = node => { nodes.push(Object.fromEntries(['Node Type', 'Relation Name', 'Actual Rows', 'Actual Loops', 'Actual Total Time', 'Shared Hit Blocks', 'Shared Read Blocks'].filter(k => node[k] !== undefined).map(k => [k, node[k]]))); for (const child of node.Plans || []) visit(child); }; visit(explain.Plan);
    plans.push({ module: name, planningMs: explain['Planning Time'], executionMs: explain['Execution Time'], nodes: nodes.sort((a, b) => b['Actual Total Time'] * b['Actual Loops'] - a['Actual Total Time'] * a['Actual Loops']).slice(0, 12) });
  }
  console.log(JSON.stringify({ environment: native ? 'owned disposable PostgreSQL17.11 loopback; no hosted provider/TLS/Singapore/cold-start simulation' : 'isolated in-process PGlite; no network/auth provider/TLS/pool/cold-start simulation', samples: 10, seed: { rooms: 131, contacts: 115, rentalMonths: 12, rentalReceipts: rows.length, carVehicles: 12, carReceipts: 1440, staffCollections: 24 }, financialChecks: 'selected November obligations/allocations match exact minor units; two currencies remain isolated', results, plans }, null, 2));
} finally { await f.pg.close(); }
