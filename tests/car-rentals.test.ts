import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { carFixture,carMigration,seedCarReceiptChoices } from './support/car-fixture';
import { adapter,issuer,up } from './support/fixture';
import { PropertyService } from '../src/service';
import { CarRentalService,combinedReceiptSourceReader,readCarReceipt } from '../src/car-rentals';
import { StaffCollectionsService } from '../src/staff-collections';
import { bindIdentityRecheck } from '../src/auth';
import type { Database } from '../src/database';
const query={month:'2026-10',asOf:'2026-10-31'};
const code=(expected:string)=>(error:unknown)=>(error as {code:string}).code===expected;
async function setup(t:TestContext){const f=await carFixture();t.after(()=>f.pg.close());return f;}
async function term(t:TestContext,amount='1000'){const f=await setup(t),v=await f.vehicle(),a=await f.agreement(v.id,{agreedAmount:amount});return {...f,v,a};}

test('Car work preserves every frozen staff/finance file byte-for-byte',async()=>{
 const frozen:Record<string,string>={
  'src/staff-collections.ts':'C4804A3031E16AE6FDB195AA8165B1F8B1916BB5AE9247D29072BDD8C81235DB',
  'src/company-finance.ts':'FFA01B402508EDE1E424BC7E47C65AC78532BE5A049A3A3969BE1D60BAAC395A',
  'tests/staff-collections.test.ts':'E31FC4DEC70CE8639BC1BED31EBF90881069731F94A8F3393B3329BDA6B4727C',
  'tests/company-finance.test.ts':'92D8E31F12F21329CBB6FEB62C22A6C6EECB3328835AAA9445BF1DCD06A8CB82',
  'tests/support/operations-fixture.ts':'EFD0737611609206826AA584D0C4B00AF566330ABB57163E27E81212AB653F1A',
  'migrations/006_local_operations_records.up.sql':'D1236225E3F34DCAE489D593419F9E6A2999208D45E23E112F2CB4F1E814B0E0'};
 for(const [file,hash] of Object.entries(frozen))assert.equal(createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex').toUpperCase(),hash,file);
});
test('Vehicle registration uniqueness and revision/history guards preserve existing rental snapshots',async t=>{
 const f=await term(t),snapshot=(await f.cars.overview(f.identity,query)).agreements[0].vehicleSnapshot;
 await assert.rejects(f.vehicle({registration:String(f.v.registration).toLowerCase()}),code('DUPLICATE_VEHICLE'));
 await f.writeCar({action:'update-vehicle',vehicleId:f.v.id,expectedVersion:1,registration:'SYNTH-REVISED',status:'maintenance',notes:'Synthetic service hold'});
 await assert.rejects(f.writeCar({action:'update-vehicle',vehicleId:f.v.id,expectedVersion:1,model:'Stale change'}),code('VERSION_CONFLICT'));
 const r=await f.cars.overview(f.identity,query);assert.equal(r.vehicles[0].version,2);assert.equal(r.vehicles[0].status,'maintenance');assert.deepEqual(r.agreements[0].vehicleSnapshot,snapshot);
 assert.equal((await f.pg.query('SELECT version FROM hamdee_private.car_vehicle_revisions WHERE vehicle_id=$1',[f.v.id])).rows.length,2);
});
test('Explicit immutable term amounts, dates, customer and descriptive billing period survive renewal without generated prices',async t=>{
 const f=await term(t,'123.456789'),next=await f.agreement(f.v.id,{startDate:'2026-11-01',endDate:'2026-11-10',agreedAmount:'77.1',billingPeriod:'Explicit ten-day total',previousAgreementId:f.a.id});
 const r=await f.cars.overview(f.identity,query);assert.equal(r.agreements.length,2);assert.equal(r.agreements.find(a=>a.id===f.a.id)!.agreedAmount,'123.456789');assert.equal(next.previousAgreementId,f.a.id);assert.equal(r.summary.length,0);
 await assert.rejects(f.pg.query('UPDATE hamdee_private.car_agreements SET agreed_amount=1 WHERE id=$1',[f.a.id]));
 await assert.rejects(f.agreement(f.v.id,{billingPeriod:''}));await assert.rejects(f.agreement(f.v.id,{endDate:'2026-09-30'}));
 await assert.rejects(f.agreement(f.v.id,{previousAgreementId:f.a.id}),code('INVALID_RENEWAL'));
 await assert.rejects(f.agreement(f.v.id,{agreementKey:f.a.agreementKey}),code('DUPLICATE_AGREEMENT'));
});
test('Partial cash/bank collections reconcile the explicit term; pending cheques never reserve or become cash',async t=>{
 const f=await term(t,'100');await f.collection(f.a.id,{amount:'40'});await f.collection(f.a.id,{amount:'60',method:'bank'});await f.collection(f.a.id,{amount:'500',method:'cheque'});
 const r=await f.cars.overview(f.identity,query);assert.equal(r.summary[0].cashCollected,'100');assert.equal(r.summary[0].pendingCheques,'500');assert.equal(r.collections.find(c=>c.method==='cheque')!.status,'pending');
 await assert.rejects(f.collection(f.a.id,{amount:'0.01'}),code('CAR_COLLECTION_EXCEEDED'));
 await assert.rejects(f.writeCar({action:'clear-cheque',receiptId:r.collections[2].id}),code('INVALID_OPERATION'));
 await assert.rejects(f.collection(f.a.id,{currency:'XXX'}),code('CURRENCY_MISMATCH'));
});
test('Receipt identity, replay and PGlite competing collections prevent duplicate or excessive cash; native races are not claimed',async t=>{
 const f=await term(t,'100'),receiptKey=randomUUID(),key=randomUUID(),body={action:'record-collection',agreementId:f.a.id,receiptKey,amount:'10',currency:'XTS',receivedDate:'2026-10-15',method:'cash'};
 const first=await f.cars.mutate(f.identity,body,key,randomUUID()),retry=await f.cars.mutate(f.identity,body,key,randomUUID());assert.equal(first.data.id,retry.data.id);assert.equal(retry.replay,true);
 await assert.rejects(f.writeCar(body),code('DUPLICATE_RECEIPT'));await assert.rejects(f.writeCar({...body,amount:'11'},key),code('IDEMPOTENCY_KEY_REUSED'));
 const concurrent=await Promise.allSettled([f.collection(f.a.id,{amount:'70'}),f.collection(f.a.id,{amount:'70'})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.cars.overview(f.identity,query)).summary[0].cashCollected,'80');
});
test('Vehicle expense and maintenance history share actual-cost identity and never charge maintenance twice',async t=>{
 const f=await term(t),expenseKey=randomUUID();await f.expense(f.v.id,{expenseKey,amount:'12.50',vendorName:'Synthetic workshop',description:'Synthetic repair'});
 await assert.rejects(f.expense(f.v.id,{action:'record-maintenance',expenseKey}),code('DUPLICATE_EXPENSE'));
 await f.expense(f.v.id,{action:'record-maintenance',amount:'0',description:'Owner-entered no-charge maintenance'});
 const other=await f.vehicle();await assert.rejects(f.expense(other.id,{agreementId:f.a.id}),code('VEHICLE_AGREEMENT_MISMATCH'));
 const r=await f.cars.overview(f.identity,query);assert.equal(r.expenses.length,2);assert.equal(r.expenses.find(e=>e.kind==='maintenance')!.amount,'0');assert.equal(r.summary[0].recordedCosts,'12.5');assert.equal(r.summary[0].recordedComparison,'-12.5');
});
test('Monthly cash/cost comparison has inclusive cutoffs, vehicle filtering and separate currencies without profit or FX',async t=>{
 const f=await term(t);await f.collection(f.a.id,{receivedDate:'2026-09-30',amount:'50'});await f.collection(f.a.id,{receivedDate:'2026-10-05',amount:'100'});await f.collection(f.a.id,{receivedDate:'2026-10-25',amount:'200'});await f.collection(f.a.id,{receivedDate:'2026-10-12',method:'cheque',amount:'500'});
 await f.expense(f.v.id,{expenseDate:'2026-10-10',amount:'20'});await f.expense(f.v.id,{expenseDate:'2026-10-20',amount:'30'});await f.expense(f.v.id,{expenseDate:'2026-10-10',amount:'10',currency:'XXX'});
 const other=await f.vehicle(),a=await f.agreement(other.id);await f.collection(a.id,{amount:'900'});
 const r=await f.cars.overview(f.identity,{...query,vehicleId:String(f.v.id),asOf:'2026-10-15'}),xts=r.summary.find(s=>s.currency==='XTS')!;
 assert.equal(xts.cashCollected,'100');assert.equal(xts.recordedCosts,'20');assert.equal(xts.recordedComparison,'80');assert.equal(xts.pendingCheques,'500');assert.equal(r.summary.find(s=>s.currency==='XXX')!.recordedComparison,'-10');assert.equal(r.summary.every(s=>s.vehicleId===f.v.id),true);
 const full=await f.cars.overview(f.identity,{...query,vehicleId:String(f.v.id)});assert.equal(full.summary.find(s=>s.currency==='XTS')!.recordedComparison,'250');assert.match(full.basis,/not profit/);
});
test('Combined authoritative adapter integrates car receipts into staff custody/company transfers without modifying frozen sources',async t=>{
 const f=await term(t),receipt=await f.collection(f.a.id,{amount:'50'}),pending=await f.collection(f.a.id,{amount:'200',method:'cheque'}),collector=await f.collector(),account=await f.account();
 const choices=await f.staff.receipts(f.identity,{asOf:'2026-10-31'});assert.equal(choices.data.length,2);assert.equal(choices.data.find(r=>r.id===receipt.id)!.customerLabel,'Synthetic car customer');
 await f.collectCar(collector.id,receipt.id);await f.collectCar(collector.id,pending.id);await f.handover(collector.id,account.id,{amount:'20'});
 const s=await f.staff.overview(f.identity,query);assert.equal(s.totals[0].balance,'30');assert.equal(s.totals[0].pending,'200');
 const company=await f.finance.overview(f.identity,query);assert.equal(company.totals[0].receipts,'0');assert.equal(company.totals[0].transfersIn,'20');
 await assert.rejects(f.writeFinance({action:'receive',accountId:account.id,sourceKind:'car-rental',sourceId:receipt.id,ownerConfirmedDisposition:true}),code('SOURCE_ALREADY_LINKED'));
 const source=await f.properties.ownerContext(f.identity,sql=>readCarReceipt(sql,String(receipt.id)));assert.equal(source!.vehicleId,f.v.id);assert.equal(source!.amount,'50');assert.equal(source!.vehicleRegistration,f.v.registration);
});
test('Composed receipt picker traverses >100 car receipts and existing source kinds with stable global cursor ordering',async t=>{
 const f=await term(t),cars=await seedCarReceiptChoices(f,f.a,120),property=await f.rentSource(),classified=await f.receipt();
 const expected=[...cars,{kind:'property-rent',id:String(property.id),date:'2026-10-15'},{kind:'classified-receipt',id:String(classified.id),date:'2026-10-15'}];
 const first=await f.staff.receipts(f.identity,{asOf:'2026-10-31'});assert.equal(first.data.length,100);assert.ok(first.nextCursor);
 const next=await f.staff.receipts(f.identity,{asOf:'2026-10-31',cursor:first.nextCursor});assert.equal(next.data.length,22);assert.equal(next.nextCursor,null);
 const key=(r:{kind:string;date:string;id:string})=>`${r.kind}|${r.date}|${r.id}`;assert.deepEqual([...first.data,...next.data].map(key),expected.map(key).sort());
 const filtered=await f.staff.receipts(f.identity,{asOf:'2026-10-31',propertyId:String(property.propertyId)});assert.equal(filtered.data.length,1);assert.equal(filtered.data[0].kind,'property-rent');
});
test('Car audit failures and late owner-session loss roll back source records, command results and revisions',async t=>{
 const f=await term(t),base=adapter(f.pg);let fail=true;const db:Database={transaction:work=>base.transaction(sql=>work({query:(statement,params)=>{if(fail&&statement.startsWith('INSERT INTO hamdee_private.ops_events'))throw new Error('Synthetic audit failure');return sql.query(statement,params);}}))};
 const service=new CarRentalService(new PropertyService(db,f.identity)),key=randomUUID(),body={action:'record-collection',agreementId:f.a.id,receiptKey:randomUUID(),receivedDate:'2026-10-15',amount:'20',currency:'XTS',method:'cash'};
 await assert.rejects(service.mutate(f.identity,body,key,randomUUID()));assert.equal((await f.pg.query('SELECT id FROM hamdee_private.car_receipts')).rows.length,0);assert.equal((await f.pg.query('SELECT key FROM hamdee_private.ops_commands WHERE key=$1',[key])).rows.length,0);
 fail=false;await service.mutate(f.identity,body,key,randomUUID());const late=bindIdentityRecheck(f.identity,async()=>{throw new Error('Synthetic expired owner session');});
 await assert.rejects(f.cars.mutate(late,{action:'update-vehicle',vehicleId:f.v.id,expectedVersion:1,model:'Must roll back'},randomUUID(),randomUUID()));assert.equal((await f.cars.overview(f.identity,query)).vehicles[0].version,1);
});
test('Owner-only RLS, immutable terms/receipts/costs and mandatory history reject raw changes and client financial authority',async t=>{
 const f=await term(t);await f.collection(f.a.id);await f.expense(f.v.id);
 await assert.rejects(f.cars.overview({issuer,subject:f.users.ops.subject},query),code('OWNER_ACCESS_DENIED'));
 await adapter(f.pg).transaction(async sql=>{await sql.query('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true)",[f.users.ops.id]);assert.equal((await sql.query('SELECT id FROM hamdee_private.car_receipts')).rows.length,0);});
 await assert.rejects(f.pg.exec('UPDATE hamdee_private.car_receipts SET amount=1'));await assert.rejects(f.pg.exec('DELETE FROM hamdee_private.car_expenses'));await assert.rejects(f.pg.query('UPDATE hamdee_private.car_vehicles SET version=version+1 WHERE id=$1',[f.v.id]));
 await assert.rejects(f.collection(f.a.id,{status:'recorded',role:'admin'}),code('INVALID_OPERATION'));await assert.rejects(f.collection(f.a.id,{amount:'1e3'}));await assert.rejects(f.collection(f.a.id,{receivedDate:'2026-02-30'}));
});
test('Migration 007 refuses missing local operations prerequisites before creating any car tables',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec(await up());await assert.rejects(pg.transaction(async tx=>{await tx.exec(await carMigration());}));
 assert.equal((await pg.query<{name:string|null}>("SELECT to_regclass('hamdee_private.car_vehicles')::text AS name")).rows[0].name,null);
});
test('Car contracts, exact source receipts, costs and linked collector balances survive disk close/reopen',async t=>{
 const f=await carFixture(true),v=await f.vehicle(),a=await f.agreement(v.id),r=await f.collection(a.id,{amount:'40.123456789012'});await f.expense(v.id,{amount:'5'});
 const c=await f.collector(),account=await f.account();await f.collectCar(c.id,r.id);await f.handover(c.id,account.id,{amount:'10'});await f.pg.close();
 const pg=new PGlite(f.dataDir);t.after(()=>pg.close());const properties=new PropertyService(adapter(pg),f.identity),service=new CarRentalService(properties);
 const cars=await service.overview(f.identity,query);assert.equal(cars.summary[0].recordedComparison,'35.123456789012');assert.equal(cars.agreements[0].agreedAmount,'1000');
 const staff=new StaffCollectionsService(properties,combinedReceiptSourceReader);assert.equal((await staff.overview(f.identity,query)).totals[0].balance,'30.123456789012');
});
