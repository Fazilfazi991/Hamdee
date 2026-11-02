import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {ExpenseService} from '../src/expenses';

const query={month:'2026-11',asOf:'2026-11-30'};
type Row=Record<string,unknown>;
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());
 await f.pg.exec(await readFile(new URL('../migrations/014_local_connected_funding.up.sql',import.meta.url),'utf8'));
 const p=await f.create(),expenses=new ExpenseService(f.properties);
 const write=async(body:unknown,key=randomUUID())=>await f.rental.mutate(f.identity,body,key,randomUUID()) as {data:Row;replay:boolean};
 const room=(await write({action:'create-room',propertyId:p.id,code:'QA-ROOM',label:'Synthetic QA room'})).data;
 const tenant=(await write({action:'create-tenant',name:'Synthetic independent QA customer'})).data;
 const agreement=(await write({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-01',monthlyRent:'2000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit synthetic monthly rent'})).data;
 const due=(await write({action:'issue-due',agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-05',amount:'2000'})).data;
 const expense=async(body:unknown,key=randomUUID())=>await expenses.mutate(f.identity,body,key,randomUUID()) as {data:Row;replay:boolean};
 return {...f,p,agreement,due,expenses,expense,write};
}

test('independent QA: competing receipt retries create one allocation, claim and money entry, retaining later month balance',async t=>{
 const f=await setup(t),cash=await f.account({openingDate:'2026-11-01'}),key=randomUUID();
 const body={action:'record-collection',agreementId:f.agreement.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-03',allocations:[{dueId:f.due.id,amount:'1200'}],receivingAccountId:cash.id,accountConfirmed:true};
 const attempts=await Promise.all([f.write(body,key),f.write(body,key)]);
 assert.equal(attempts[0].data.id,attempts[1].data.id);
 assert.equal(attempts.filter(r=>r.replay).length,1);
 const current=await f.rental.overview(f.identity,query);
 assert.equal((current.dues[0] as Row).outstandingMinor,'80000');assert.equal(current.collections.length,1);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_allocations')).rows.length,1);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_claims')).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_money WHERE entry_kind='receipt'")).rows.length,1);
 const december=await f.rental.overview(f.identity,{month:'2026-12',asOf:'2026-12-01'});
 assert.equal(december.collections.length,1);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_collections')).rows.length,1);
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),1200);
});

test('independent QA: mismatched account rejects collection atomically, and valid retry with original key succeeds',async t=>{
 const f=await setup(t),otherCurrency=await f.account({currency:'QAR',openingDate:'2026-11-01'}),cash=await f.account({openingDate:'2026-11-01'}),key=randomUUID();
 const body={action:'record-collection',agreementId:f.agreement.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-03',allocations:[{dueId:f.due.id,amount:'1200'}],receivingAccountId:otherCurrency.id,accountConfirmed:true};
 await assert.rejects(f.write(body,key));
 for(const table of ['rent_collections','rent_allocations','ops_claims'])assert.equal((await f.pg.query('SELECT * FROM hamdee_private.'+table)).rows.length,0,table);
 await f.write({...body,receivingAccountId:cash.id},key);
 assert.equal(((await f.rental.overview(f.identity,query)).dues[0] as Row).outstandingMinor,'80000');
});

test('independent QA: bill payment competing retries spend only 200 and retain one 600 bill',async t=>{
 const f=await setup(t),cash=await f.account({openingDate:'2026-11-01',openingAmount:'1000'}),key=randomUUID();
 const bill={action:'record-expense',propertyId:f.p.id,category:'cleaning',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic QA vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-03',fundingAccountId:cash.id}};
 const results=await Promise.all([f.expense(bill,key),f.expense(bill,key)]);
 assert.equal(results[0].data.id,results[1].data.id);assert.equal(results.filter(r=>r.replay).length,1);
 const costs=await f.expenses.overview(f.identity,query);
 assert.equal(costs.expenses.length,1);assert.equal((costs.expenses[0] as Row).paidMinor,'20000');
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.expense_funding_links')).rows.length,1);
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),800);
 await assert.rejects(f.expense({...bill,amount:'601'},key));
 assert.equal((await f.expenses.overview(f.identity,query)).expenses.length,1);
});

test('independent QA: personal spending reduces chosen account without becoming property operating cost',async t=>{
 const f=await setup(t),personal=await f.account({scope:'personal',kind:'bank',openingAmount:'1000',openingDate:'2026-11-01'});
 const before=await f.expenses.overview(f.identity,query),key=randomUUID();
 const body={action:'expense',accountId:personal.id,expenseKey:randomUUID(),amount:'75',paidOn:'2026-11-03',reference:'Synthetic personal spending',notes:'Owner supplied personal classification'};
 await f.writeFinance(body,key);await f.writeFinance(body,key);
 const ledger=await f.finance.overview(f.identity,{...query,accountId:String(personal.id)});
 assert.equal(Number(ledger.totals[0].balance),925);
 const after=await f.expenses.overview(f.identity,query);assert.deepEqual(after.summary,before.summary);assert.deepEqual(after.expenses,[]);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.property_expenses')).rows.length,0);
});
