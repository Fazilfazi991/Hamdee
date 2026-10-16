import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createOwnerQaFixture,seedOwnerAppRecords} from './support/owner-crm-harness';
import {adapter,up} from './support/fixture';
const base='/api/hamdee/v1',query='month=2026-10&asOf=2026-10-31';
const migrationFiles=['006_local_operations_records.up.sql','007_local_car_rentals.up.sql'];
type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
async function result(r:Response,status=200,code?:string){const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));assert.equal(r.headers.get('Cache-Control'),'private, no-store');if(code)assert.equal(b.error?.code,code);return b;}
async function setup(t:TestContext){const f=await createOwnerQaFixture({migrationFiles});t.after(()=>f.close());await f.login();return f;}
const command=(f:Fixture,module:string,body:unknown,key=randomUUID(),status=200,code?:string)=>f.request('POST',`${base}/${module}/commands`,body,{'Idempotency-Key':key}).then(r=>result(r,status,code));
async function vehicle(f:Fixture){return (await command(f,'car-rentals',{action:'create-vehicle',registration:'SYN-'+randomUUID().slice(0,8),make:'Synthetic make',model:'Synthetic model',status:'active'})).data;}
async function agreement(f:Fixture,vehicleId:string){return (await command(f,'car-rentals',{action:'create-agreement',vehicleId,agreementKey:randomUUID(),customerName:'Synthetic car customer',startDate:'2026-10-01',endDate:'2026-10-31',agreedAmount:'100',currency:'XTS',billingPeriod:'Explicit total for saved term'})).data;}
async function account(f:Fixture,scope:string,openingAmount='0'){return (await command(f,scope+'-finance',{action:'create-account',name:'Synthetic '+scope+' cash',scope,kind:'cash',currency:'XTS',openingDate:'2026-10-01',openingAmount,ownerConfirmedOpening:true})).data;}

test('Actual owner car API covers availability, immutable dates/amounts, partial cash/bank, pending balance and one maintenance cost',async t=>{
 const f=await setup(t),v=await vehicle(f),a=await agreement(f,v.id),key=randomUUID();
 const body={action:'record-collection',agreementId:a.id,receiptKey:randomUUID(),receivedDate:'2026-10-15',amount:'30',currency:'XTS',method:'cash'};
 const saved=await command(f,'car-rentals',body,key),replay=await command(f,'car-rentals',body,key);assert.equal(replay.replay,true);assert.deepEqual(saved.data,replay.data);
 await command(f,'car-rentals',{...body,receiptKey:randomUUID(),amount:'20',method:'bank'});await command(f,'car-rentals',{...body,receiptKey:randomUUID(),amount:'100',method:'cheque'});
 const expenseKey=randomUUID(),cost={action:'record-maintenance',vehicleId:v.id,expenseKey,expenseDate:'2026-10-15',amount:'12.5',currency:'XTS',description:'Synthetic actual service'};
 await command(f,'car-rentals',cost);await command(f,'car-rentals',{...cost,action:'record-expense'},randomUUID(),409,'DUPLICATE_EXPENSE');
 const view=(await result(await f.request('GET',base+'/car-rentals?'+query+'&vehicleId='+v.id))).data;assert.equal(view.balances[0].outstandingAmount,'50');assert.equal(view.balances[0].pendingChequeAmount,'100');assert.equal(view.availability[0].reason,'rented');assert.equal(view.summary[0].cashCollected,'50');assert.equal(view.summary[0].recordedCosts,'12.5');assert.equal(view.summary[0].recordedComparison,'37.5');assert.equal(view.expenses.length,1);
 const free=(await result(await f.request('GET',base+'/car-rentals?'+query+'&availabilityStart=2026-11-01&availabilityEnd=2026-11-02'))).data;assert.equal(free.availability[0].available,true);
 await command(f,'car-rentals',{action:'create-agreement',vehicleId:v.id,agreementKey:randomUUID(),customerName:'Synthetic overlap',startDate:'2026-10-31',endDate:'2026-11-01',agreedAmount:'2',currency:'XTS',billingPeriod:'Explicit total'},randomUUID(),409,'VEHICLE_UNAVAILABLE');
 await command(f,'car-rentals',{...body,receiptKey:randomUUID(),amount:'51'},randomUUID(),409,'CAR_COLLECTION_EXCEEDED');
});

test('Owner company/personal APIs isolate balances and explicitly transfer once without counting transfers as income',async t=>{
 const f=await setup(t),c=await account(f,'company','100'),p=await account(f,'personal'),key=randomUUID();
 const b={action:'transfer',fromAccountId:c.id,toAccountId:p.id,amount:'25',transferredOn:'2026-10-16',reference:'SYNTHETIC-EXPLICIT-TRANSFER'};
 await command(f,'company-finance',b,key);assert.equal((await command(f,'company-finance',b,key)).replay,true);
 await command(f,'personal-finance',b,key,409,'IDEMPOTENCY_KEY_REUSED');
 const company=(await result(await f.request('GET',base+'/company-finance?'+query))).data,personal=(await result(await f.request('GET',base+'/personal-finance?'+query))).data;
 assert.deepEqual(company.accounts.map((a:{id:string})=>a.id),[c.id]);assert.deepEqual(personal.accounts.map((a:{id:string})=>a.id),[p.id]);assert.equal(company.totals[0].balance,'75');assert.equal(personal.totals[0].balance,'25');assert.equal(company.totals[0].receipts,'0');assert.equal(personal.totals[0].receipts,'0');assert.equal(personal.transferAccounts.length,2);
 await result(await f.request('GET',base+'/personal-finance?'+query+'&accountId='+c.id),409,'ACCOUNT_SCOPE_MISMATCH');
 await command(f,'personal-finance',{action:'expense',accountId:c.id,expenseKey:randomUUID(),paidOn:'2026-10-17',amount:'1'},randomUUID(),409,'ACCOUNT_SCOPE_MISMATCH');
});

test('Car API receipt is authoritative in existing staff picker and direct company ledger, with no duplicate custody/income',async t=>{
 const f=await setup(t),v=await vehicle(f),a=await agreement(f,v.id),c=await account(f,'company');
 const receipt=(await command(f,'car-rentals',{action:'record-collection',agreementId:a.id,receiptKey:randomUUID(),receivedDate:'2026-10-15',amount:'40',currency:'XTS',method:'bank'})).data;
 const source={action:'receive',accountId:c.id,sourceKind:'car-rental',sourceId:receipt.id,ownerConfirmedDisposition:true};await command(f,'company-finance',source);await command(f,'company-finance',source,randomUUID(),409,'SOURCE_ALREADY_LINKED');
 const choices=(await result(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-31'))).data;assert.equal(choices.data[0].kind,'car-rental');assert.equal(choices.data[0].companyAccountId,c.id);
 const collector=(await command(f,'staff-collections',{action:'create-collector',name:'Synthetic contact'})).data;
 await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'car-rental',sourceId:receipt.id,disposition:'company-direct',accountId:c.id,ownerConfirmedDisposition:true});
 const staff=(await result(await f.request('GET',base+'/staff-collections?'+query))).data;assert.equal(staff.totals[0].companyDirect,'40');assert.equal(staff.totals[0].balance,'0');assert.equal((await result(await f.request('GET',base+'/company-finance?'+query))).data.totals[0].receipts,'40');
});

test('New car/personal API rejects anonymous, stale sessions, CSRF, oversized bodies, invalid filters and client authority fields',async t=>{
 const f=await setup(t);
 for(const module of ['car-rentals','personal-finance']){
  await result(await f.request('POST',base+'/'+module+'/commands',{action:'bad'},{'Idempotency-Key':randomUUID(),'X-Hamdee-CSRF':''}),403,'CSRF_REJECTED');
  await result(await f.request('POST',base+'/'+module+'/commands',{notes:'x'.repeat(17_000)},{'Idempotency-Key':randomUUID()}),413,'PAYLOAD_TOO_LARGE');
  await result(await f.request('GET',base+'/'+module+'?'+query+'&amount=2'),400,'INVALID_QUERY');
 }
 for(const extra of ['&availabilityStart=2026-02-30','&availabilityStart=2026-11-02&availabilityEnd=2026-11-01','&availabilityStart=2026-10-01&availabilityStart=2026-10-02','&vehicleId=bad'])await result(await f.request('GET',base+'/car-rentals?'+query+extra),400,'INVALID_QUERY');
 await command(f,'car-rentals',{action:'create-vehicle',registration:'SYN-BAD',make:'Synthetic',model:'Synthetic',status:'active',role:'admin'},randomUUID(),422,'INVALID_OPERATION');
 const old=f.jar.fork();await f.auth('POST','logout',{});
 for(const module of ['car-rentals','personal-finance'])await result(await f.request('GET',base+'/'+module+'?'+query,undefined,{},old),401);
});

test('No car007 remains independent of Staff006, finance, owner login and property activation',async t=>{
 const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql']});t.after(()=>f.close());await f.login();
 await account(f,'company');await account(f,'personal');await result(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-31'));await result(await f.request('GET',base+'/staff-collections?'+query));await result(await f.request('GET',base+'/personal-finance?'+query));await result(await f.request('GET',base+'/car-rentals?'+query),503);await result(await f.request('GET',base+'/dashboard'));
});

test('Car and separate account state/replay survive disk reopen and a fresh managed owner login',async t=>{
 const directory=path.resolve('.test-data','car-finance-api-'+randomUUID());await mkdir(directory,{recursive:true});let pg=new PGlite(directory);t.after(async()=>{if(!pg.closed)await pg.close();});await pg.exec(await up(migrationFiles));await seedOwnerAppRecords(pg);
 const f=await createOwnerQaFixture({database:adapter(pg),pg});await f.login();const v=await vehicle(f),a=await agreement(f,v.id),c=await account(f,'company','100'),p=await account(f,'personal'),key=randomUUID();
 const b={action:'transfer',fromAccountId:c.id,toAccountId:p.id,transferredOn:'2026-10-16',amount:'20',reference:'SYNTHETIC-PERSISTED'};await command(f,'company-finance',b,key);await pg.close();pg=new PGlite(directory);
 const reopened=await createOwnerQaFixture({database:adapter(pg),pg});await reopened.login();const cars=(await result(await reopened.request('GET',base+'/car-rentals?'+query))).data;assert.equal(cars.agreements[0].id,a.id);assert.equal(cars.balances[0].outstandingAmount,'100');assert.equal((await command(reopened,'company-finance',b,key)).replay,true);
 assert.equal((await result(await reopened.request('GET',base+'/company-finance?'+query))).data.totals[0].balance,'80');assert.equal((await result(await reopened.request('GET',base+'/personal-finance?'+query))).data.totals[0].balance,'20');
});
