import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { LocalPostgresDatabase, type Database, type Sql } from '../../src/database';
import { PropertyService } from '../../src/service';
import { CarRentalService } from '../../src/car-rentals';
import { CompanyFinanceService, type OperationRow } from '../../src/company-finance';
import { up } from '../support/fixture';
import { createOwnerQaFixture, inspectOwnerPortableRuntime, startOwnerNativeCluster, ownerNativeConnection, ownerQaInputs, seedOwnerAppRecords } from '../support/owner-crm-harness';

// Reuses the inspection/start/restart/cleanup functions used by run-native.mjs.
// No launcher edits, downloads, generic DB environment or hosted connections.
let cluster: Awaited<ReturnType<typeof startOwnerNativeCluster>> | undefined;
let pool: Pool, db1: LocalPostgresDatabase, db2: LocalPostgresDatabase;
let properties1: PropertyService, properties2: PropertyService;
const input = ownerQaInputs(), identity = { issuer: input.issuer, subject: input.ownerSubject };
const evidence: Record<string, unknown> = {};
const witness: Record<string, string> = {};
function rendezvous() {
  const pids = new Set<number>(); let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { pids, async enter(sql: Sql) {
    pids.add((await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    if (pids.size === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Two native transactions did not rendezvous')), 15000); })]); }
    finally { clearTimeout(timer); }
  } };
}
let gate: ReturnType<typeof rendezvous> | undefined;
function observed(db: Database): Database {
  return { transaction: work => db.transaction(sql => work({ query: async <T>(text: string, params?: unknown[]) => {
    if (gate && text.includes('pg_advisory_xact_lock') && params?.[0] === 'hamdee-operations-money') await gate.enter(sql);
    return sql.query<T>(text, params);
  } })) };
}
function connect() {
  assert.ok(cluster); pool = new Pool(ownerNativeConnection(cluster.connection, 'disposable-local-hamdee-owner'));
  db1 = new LocalPostgresDatabase(cluster.connection, () => {}); db2 = new LocalPostgresDatabase(cluster.connection, () => {});
  properties1 = new PropertyService(observed(db1), identity); properties2 = new PropertyService(observed(db2), identity);
}
async function disconnect() { await Promise.all([pool?.end(), db1?.close(), db2?.close()]); }
before(async () => {
  const tools = path.resolve('../hamdee-production-foundation/hamdee-foundation/.test-tools');
  const runtime = await inspectOwnerPortableRuntime(path.join(tools, 'postgresql-17.11-5-windows-x64-binaries.zip'), path.join(tools, 'postgresql-17.11-5'));
  cluster = await startOwnerNativeCluster(runtime); connect();
  await pool.query(await up(['006_local_operations_records.up.sql', '007_local_car_rentals.up.sql'])); await seedOwnerAppRecords(pool);
}, { timeout: 120000 });
after(async () => {
  gate = undefined;
  try { await disconnect(); } finally {
    await cluster?.close(); evidence.engine = cluster?.evidence();
    await mkdir('evidence/car-finance-qa', { recursive: true });
    await writeFile('evidence/car-finance-qa/native-evidence.json', JSON.stringify(evidence, null, 2));
  }
});
const write = async (service: CarRentalService | CompanyFinanceService, body: unknown, key = randomUUID()) => service.mutate(identity, body, key, randomUUID());
const data = (value: { data: unknown }) => value.data as OperationRow;
async function race<T>(left: () => Promise<T>, right: () => Promise<T>) {
  const current = rendezvous(); gate = current;
  try {
    const outcomes = await Promise.allSettled([left(), right()]); assert.equal(current.pids.size, 2);
    return { outcomes, pids: [...current.pids] };
  } finally { gate = undefined; }
}
function oneWinner<T>(outcomes: PromiseSettledResult<T>[], code: string): T {
  const success = outcomes.filter((row): row is PromiseFulfilledResult<T> => row.status === 'fulfilled');
  const failures = outcomes.filter((row): row is PromiseRejectedResult => row.status === 'rejected');
  assert.equal(success.length, 1); assert.equal(failures.length, 1); assert.equal(failures[0].reason.status, 409); assert.equal(failures[0].reason.code, code);
  return success[0].value;
}

test('Native independent: two PostgreSQL service transactions race overlapping vehicle terms; one409 and no losing event or command', async () => {
  const left = new CarRentalService(properties1), right = new CarRentalService(properties2);
  const vehicle = data(await write(left, { action: 'create-vehicle', registration: 'SYNTHETIC-NATIVE-' + randomUUID().slice(0, 8), make: 'Synthetic', model: 'Native race', status: 'active' }));
  witness.vehicleId = String(vehicle.id);
  const body = { action: 'create-agreement', vehicleId: vehicle.id, customerName: 'Synthetic native customer', startDate: '2026-10-01', endDate: '2026-10-31', agreedAmount: '10', currency: 'QAR', billingPeriod: 'Explicit whole term total' };
  const firstKey = randomUUID(), secondKey = randomUUID();
  const run = await race(() => write(left, { ...body, agreementKey: randomUUID() }, firstKey), () => write(right, { ...body, agreementKey: randomUUID() }, secondKey));
  witness.agreementId = String(data(oneWinner(run.outcomes, 'VEHICLE_UNAVAILABLE')).id);
  const commands = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.ops_commands WHERE key=ANY($1::uuid[])', [[firstKey, secondKey]]);
  assert.equal(commands.rows[0].n, 1);
  assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.car_agreements WHERE vehicle_id=$1', [vehicle.id])).rows[0].n, 1);
  // Negative insert uses fresh owner context/RLS and the real DB trigger. It
  // intentionally fails before deferred audit FK checks; no event is inserted.
  await assert.rejects(() => properties1.ownerContext(identity, sql => sql.query(`INSERT INTO hamdee_private.car_agreements
    (id,vehicle_id,agreement_key,customer_name,start_date,end_date,agreed_amount,currency,billing_period,vehicle_snapshot,event_id)
    SELECT $1,v.id,$2,'Synthetic rejected overlap','2026-10-31','2026-11-01',1,'QAR','Explicit total',to_jsonb(v)-'event_id',$3
    FROM hamdee_private.car_vehicles v WHERE v.id=$4`, [randomUUID(), randomUUID(), randomUUID(), vehicle.id])), /overlaps/);
  evidence.vehicleOverlap = { pids: run.pids, successes: 1, conflicts409: 1, commands: 1, directDatabaseOverlapDenied: true };
});

test('Native independent: simultaneous identical collection commands replay one receipt and changed payload rolls back', async () => {
  const left = new CarRentalService(properties1), right = new CarRentalService(properties2), key = randomUUID();
  const body = { action: 'record-collection', agreementId: witness.agreementId, receiptKey: randomUUID(), receivedDate: '2026-10-15', amount: '3', currency: 'QAR', method: 'cash', reference: 'SYNTHETIC-NATIVE-RECEIPT' };
  const run = await race(() => write(left, body, key), () => write(right, body, key));
  assert.ok(run.outcomes.every(row => row.status === 'fulfilled'));
  const values = run.outcomes.map(row => { assert.equal(row.status, 'fulfilled'); return row.value; });
  assert.deepEqual(values.map(row => row.replay).sort(), [false, true]); assert.deepEqual(values[0].data, values[1].data);
  witness.receiptId = String(data(values[0]).id);
  await assert.rejects(() => write(right, { ...body, amount: '4' }, key), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.car_receipts WHERE agreement_id=$1', [witness.agreementId])).rows[0].n, 1);
  assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.ops_commands WHERE key=$1', [key])).rows[0].n, 1);
  evidence.collectionReplay = { pids: run.pids, receipts: 1, commands: 1, changedPayload409: true };
});

test('Native independent: competing transfers cannot overspend; failed command leaves no partial paired cash entries', async () => {
  const left = new CompanyFinanceService(properties1), right = new CompanyFinanceService(properties2);
  const account = async (scope: string, amount: string) => data(await write(left, { action: 'create-account', name: 'Synthetic native ' + scope, scope, kind: 'cash', currency: 'QAR', openingDate: '2026-10-01', openingAmount: amount, ownerConfirmedOpening: true }));
  const company = await account('company', '10'), personal = await account('personal', '0');
  witness.companyId = String(company.id); witness.personalId = String(personal.id);
  const body = { action: 'transfer', fromAccountId: company.id, toAccountId: personal.id, transferredOn: '2026-10-16', amount: '7' }, firstKey = randomUUID(), secondKey = randomUUID();
  const run = await race(() => write(left, { ...body, reference: 'SYNTHETIC-NATIVE-A' }, firstKey), () => write(right, { ...body, reference: 'SYNTHETIC-NATIVE-B' }, secondKey));
  witness.transferId = String(data(oneWinner(run.outcomes, 'INSUFFICIENT_FUNDS')).id);
  const rows = await pool.query<{ account_id: string; balance: string }>('SELECT account_id,sum(delta)::text AS balance FROM hamdee_private.ops_money WHERE account_id=ANY($1::uuid[]) GROUP BY account_id', [[company.id, personal.id]]);
  assert.equal(rows.rows.find(row => row.account_id === company.id)!.balance, '3'); assert.equal(rows.rows.find(row => row.account_id === personal.id)!.balance, '7');
  const paired = await pool.query<{ n: number; delta: string }>('SELECT count(*)::int AS n,sum(delta)::text AS delta FROM hamdee_private.ops_money WHERE transfer_id=$1', [witness.transferId]);
  assert.deepEqual(paired.rows[0], { n: 2, delta: '0' });
  assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.ops_commands WHERE key=ANY($1::uuid[])', [[firstKey, secondKey]])).rows[0].n, 1);
  evidence.overspend = { pids: run.pids, successes: 1, insufficientFunds409: 1, pairedEntries: 2, pairedDelta: '0', company: '3', personal: '7' };
});

async function snapshot() {
  return (await pool.query(`SELECT jsonb_build_object(
    'agreements',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM hamdee_private.car_agreements a),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM hamdee_private.car_receipts r),
    'money',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM hamdee_private.ops_money m),
    'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY key) FROM hamdee_private.ops_commands c),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM hamdee_private.ops_events e)) AS state`)).rows[0].state;
}
test('Native independent: actual PostgreSQL restart and fresh owner app/login preserve all race results, audit and command history', async () => {
  assert.ok(cluster); const beforeState = await snapshot(), previousPid = cluster.evidence().ownedPid;
  await disconnect(); await cluster.restart(); assert.notEqual(cluster.evidence().ownedPid, previousPid); connect();
  assert.deepEqual(await snapshot(), beforeState);
  const f = await createOwnerQaFixture({ database: db1 }); await f.login();
  const read = async (module: string) => { const response = await f.request('GET', '/api/hamdee/v1/' + module + '?month=2026-10&asOf=2026-10-31'); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data; };
  const cars = await read('car-rentals'); assert.equal(cars.balances[0].collectedAmount, '3'); assert.equal(cars.balances[0].outstandingAmount, '7');
  assert.equal(cars.collections[0].id, witness.receiptId);
  assert.equal((await read('company-finance')).totals[0].balance, '3'); assert.equal((await read('personal-finance')).totals[0].balance, '7');
  evidence.restart = { previousPid, newPid: cluster.evidence().ownedPid, sameRecordsAuditCommands: true, freshOwnerLogin: true, witness };
});
