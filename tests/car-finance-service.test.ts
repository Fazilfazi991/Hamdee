import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {carFixture} from './support/car-fixture';
import {CompanyFinanceService,type OperationRow} from '../src/company-finance';
const period={month:'2026-10',asOf:'2026-10-31'};
const code=(expected:string)=>(error:unknown)=>(error as {code:string}).code===expected;
async function setup(t:TestContext){const f=await carFixture();t.after(()=>f.pg.close());return f;}

test('Car availability uses inclusive dates/current status and rejects competing or raw overlapping terms without changing history',async t=>{
 const f=await setup(t),v=await f.vehicle(),a=await f.agreement(v.id,{endDate:'2026-10-10'});
 const atEnd=await f.cars.overview(f.identity,{...period,asOf:'2026-10-10'});
 assert.deepEqual(atEnd.availability[0],{vehicleId:v.id,startDate:'2026-10-10',endDate:'2026-10-10',available:false,reason:'rented',agreementIds:[a.id]});
 const free=await f.cars.overview(f.identity,{...period,availabilityStart:'2026-10-11',availabilityEnd:'2026-10-20'});assert.equal(free.availability[0].available,true);
 await assert.rejects(f.agreement(v.id,{startDate:'2026-10-10',endDate:'2026-10-11'}),code('VEHICLE_UNAVAILABLE'));
 await assert.rejects(f.pg.query(`INSERT INTO hamdee_private.car_agreements SELECT $1,vehicle_id,$2,customer_name,customer_contact,start_date,end_date,agreed_amount,currency,billing_period,reference,notes,previous_agreement_id,vehicle_snapshot,event_id FROM hamdee_private.car_agreements WHERE id=$3`,[randomUUID(),randomUUID(),a.id]),/overlaps/);
 const competing=await Promise.allSettled([f.agreement(v.id,{startDate:'2026-11-01',endDate:'2026-11-10'}),f.agreement(v.id,{startDate:'2026-11-01',endDate:'2026-11-10'})]);assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
 await f.writeCar({action:'update-vehicle',vehicleId:v.id,expectedVersion:1,status:'maintenance'});
 const blocked=await f.cars.overview(f.identity,{...period,asOf:'2026-10-11'});assert.equal(blocked.availability[0].available,false);assert.equal(blocked.availability[0].reason,'maintenance');assert.deepEqual(blocked.availability[0].agreementIds,[]);
 await assert.rejects(f.agreement(v.id,{startDate:'2026-12-01',endDate:'2026-12-10'}),code('VEHICLE_UNAVAILABLE'));
 await assert.rejects(f.cars.overview(f.identity,{...period,availabilityStart:'2026-10-20',availabilityEnd:'2026-10-19'}));assert.equal(blocked.agreements.length,2);
});

test('Car outstanding uses the immutable entered term and inclusive actual cash/bank cutoff, excluding pending cheques and vehicle costs',async t=>{
 const f=await setup(t),v=await f.vehicle(),a=await f.agreement(v.id,{agreedAmount:'100'});
 await f.collection(a.id,{amount:'40'});await f.collection(a.id,{amount:'10',method:'bank'});await f.collection(a.id,{amount:'100',method:'cheque'});await f.collection(a.id,{amount:'20',receivedDate:'2026-10-20'});await f.expense(v.id,{amount:'7'});
 const early=await f.cars.overview(f.identity,{...period,asOf:'2026-10-15'});
 assert.deepEqual(early.balances[0],{agreementId:a.id,vehicleId:v.id,currency:'XTS',agreedAmount:'100',collectedAmount:'50',outstandingAmount:'50',pendingChequeAmount:'100'});
 const end=await f.cars.overview(f.identity,period);assert.equal(end.balances[0].outstandingAmount,'30');assert.equal(end.summary[0].recordedComparison,'63');
});

test('Separate company/personal scoped ledgers preserve explicit transfers, dates, currencies, exact balances and replay boundaries',async t=>{
 const f=await setup(t),company=new CompanyFinanceService(f.properties,undefined,'company'),personal=new CompanyFinanceService(f.properties,undefined,'personal');
 const a=await f.account({openingAmount:'100'}),b=await f.account({scope:'personal'}),fx=await f.account({currency:'XXX',openingAmount:'900'});
 const legacyKey=randomUUID(),legacyBody={action:'create-account',name:'Synthetic published zero account',scope:'company',kind:'bank',currency:'XXX',openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true};
 const legacy=await f.finance.mutate(f.identity,legacyBody,legacyKey,randomUUID()),legacyReplay=await company.mutate(f.identity,legacyBody,legacyKey,randomUUID());assert.equal(legacyReplay.replay,true);assert.deepEqual(legacyReplay.data,legacy.data);
 const before=await company.overview(f.identity,period),privateBefore=await personal.overview(f.identity,period);assert.equal(before.scope,'company');assert.deepEqual(new Set(before.accounts.map(a=>a.id)),new Set([a.id,fx.id,legacy.data.id]));assert.deepEqual(privateBefore.accounts.map(a=>a.id),[b.id]);assert.equal(before.transferAccounts.length,4);
 const key=randomUUID(),body={action:'transfer',fromAccountId:a.id,toAccountId:b.id,transferredOn:'2026-10-16',amount:'25.123456789012',reference:'SYNTHETIC-CROSS-SCOPE'};
 const first=await company.mutate(f.identity,body,key,randomUUID()),again=await company.mutate(f.identity,body,key,randomUUID());assert.equal(again.replay,true);assert.deepEqual(again.data,first.data);
 await assert.rejects(personal.mutate(f.identity,body,key,randomUUID()),code('IDEMPOTENCY_KEY_REUSED'));
 const c=await company.overview(f.identity,{...period,accountId:String(a.id)}),p=await personal.overview(f.identity,period);assert.equal(c.totals[0].balance,'74.876543210988');assert.equal(p.totals[0].balance,'25.123456789012');assert.equal(c.totals[0].receipts,'0');assert.equal(p.totals[0].receipts,'0');assert.equal(c.totals[0].transfersOut,p.totals[0].transfersIn);
 assert.equal((await personal.overview(f.identity,{...period,asOf:'2026-10-15'})).totals[0].balance,'0');
 await assert.rejects(company.mutate(f.identity,{...body,toAccountId:fx.id,reference:'SYNTHETIC-FX'},randomUUID(),randomUUID()),code('CURRENCY_MISMATCH'));
 await assert.rejects(personal.mutate(f.identity,{...body,fromAccountId:b.id,toAccountId:a.id,amount:'26',reference:'SYNTHETIC-OVER'},randomUUID(),randomUUID()),code('INSUFFICIENT_FUNDS'));
 const expense=await personal.mutate(f.identity,{action:'expense',accountId:b.id,expenseKey:randomUUID(),paidOn:'2026-10-17',amount:'5',reference:'SYNTHETIC-PERSONAL-COST'},randomUUID(),randomUUID());
 assert.equal((await personal.overview(f.identity,period)).totals[0].balance,'20.123456789012');
 await personal.mutate(f.identity,{action:'reverse',entryId:expense.data.id,reversedOn:'2026-10-18',reason:'Synthetic actual expense correction'},randomUUID(),randomUUID());assert.equal((await personal.overview(f.identity,period)).totals[0].balance,'25.123456789012');
});

test('Scoped finance rejects incorrect account scope, invented openings, foreign reversals and pending cash placement',async t=>{
 const f=await setup(t),company=new CompanyFinanceService(f.properties,undefined,'company'),personal=new CompanyFinanceService(f.properties,undefined,'personal');
 const mutate=(service:CompanyFinanceService,b:OperationRow)=>service.mutate(f.identity,b,randomUUID(),randomUUID());
 const opening={action:'create-account',name:'Synthetic explicit opening',scope:'personal',kind:'bank',currency:'XTS',openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true};
 await assert.rejects(mutate(company,opening),code('ACCOUNT_SCOPE_MISMATCH'));await assert.rejects(mutate(personal,{...opening,openingAmount:undefined}));await assert.rejects(mutate(personal,{...opening,ownerConfirmedOpening:false}),code('OPENING_UNCONFIRMED'));
 const a=await f.account({openingAmount:'100'}),b=await f.account({scope:'personal'}),receipt=await f.receipt({method:'cheque'});
 await assert.rejects(company.overview(f.identity,{...period,accountId:String(b.id)}),code('ACCOUNT_SCOPE_MISMATCH'));
 await assert.rejects(mutate(personal,{action:'expense',accountId:a.id,expenseKey:randomUUID(),paidOn:'2026-10-15',amount:'1'}),code('ACCOUNT_SCOPE_MISMATCH'));
 await assert.rejects(mutate(personal,{action:'receive',accountId:b.id,sourceKind:'classified-receipt',sourceId:receipt.id,ownerConfirmedDisposition:true}),code('SOURCE_PENDING'));
 const expense=await mutate(company,{action:'expense',accountId:a.id,expenseKey:randomUUID(),paidOn:'2026-10-15',amount:'1'});
 await assert.rejects(mutate(personal,{action:'reverse',entryId:expense.data.id,reversedOn:'2026-10-15',reason:'Wrong ledger'}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.equal((await personal.overview(f.identity,period)).totals[0].balance,'0');assert.equal((await company.overview(f.identity,period)).totals[0].balance,'99');
});
