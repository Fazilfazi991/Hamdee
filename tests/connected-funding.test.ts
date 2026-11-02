import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './support/operations-fixture';
import { ExpenseService } from '../src/expenses';

async function setup(t: test.TestContext) {
 const f=await operationsFixture();t.after(()=>f.pg.close());
 await f.pg.exec(await readFile(new URL('../migrations/014_local_connected_funding.up.sql',import.meta.url),'utf8'));
 const p=await f.create();
 const write=async(body:unknown,key=randomUUID())=>((await f.rental.mutate(f.identity,body,key,randomUUID())) as {data:Record<string,unknown>}).data;
 const room=await write({action:'create-room',propertyId:p.id,code:'FUND',label:'Synthetic funding room'});
 const tenant=await write({action:'create-tenant',name:'Synthetic funding customer'});
 const agreement=await write({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-01',monthlyRent:'2000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit confirmed amount'});
 const due=await write({action:'issue-due',agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-02',amount:'2000'});
 const expenses=new ExpenseService(f.properties);
 const expense=async(body:unknown,key=randomUUID())=>expenses.mutate(f.identity,body,key,randomUUID()) as Promise<{data:Record<string,unknown>;replay:boolean}>;
 return {...f,p,room,tenant,agreement,due,write,expenses,expense};
}

test('one cash collection allocates 1200 of 2000, places funds once and rejects changed retry',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01'}),key=randomUUID();
 const body={action:'record-collection',agreementId:f.agreement.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-02',allocations:[{dueId:f.due.id,amount:'1200'}],receivingAccountId:account.id,accountConfirmed:true,notes:'Synthetic collection'};
 const first=await f.rental.mutate(f.identity,body,key,randomUUID());
 assert.equal((await f.rental.mutate(f.identity,body,key,randomUUID())).replay,true);
 await assert.rejects(f.rental.mutate(f.identity,{...body,amount:'1100'},key,randomUUID()));
 const rent=await f.rental.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});
 assert.equal((rent.dues[0] as Record<string,unknown>).outstandingMinor,'80000');assert.equal(rent.collections.length,1);
 const finance=await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});
 assert.equal(Number(finance.totals[0].balance),1200);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_claims')).rows.length,1);
 assert.ok((first as {data:Record<string,unknown>}).data.id);
});

test('collector collection, 1000 handover and 200 paid bill reconcile without duplicated receipt or bill',async t=>{
 const f=await setup(t),collector=await f.collector(),account=await f.account({openingDate:'2026-11-01'});
 await f.write({action:'record-collection',agreementId:f.agreement.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-02',allocations:[{dueId:f.due.id,amount:'1200'}],receivingCollectorId:collector.id,accountConfirmed:true});
 await f.handover(collector.id,account.id,{amount:'1000',handedOn:'2026-11-02'});
 let staff=await f.staff.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});
 assert.equal(Number(staff.totals[0].balance),200);assert.equal(Number(staff.totals[0].received),1200);
 const key=randomUUID(),bill={action:'record-expense',propertyId:f.p.id,category:'maintenance',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingCollectorId:collector.id}};
 const result=await f.expense(bill,key);assert.equal((await f.expense(bill,key)).replay,true);
 staff=await f.staff.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});assert.equal(Number(staff.totals[0].balance),0);
 let costs=await f.expenses.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});
 assert.equal(costs.expenses.length,1);assert.equal((costs.expenses[0] as Record<string,unknown>).paidMinor,'20000');
 await f.expense({action:'record-payment',expenseId:result.data.id,method:'cash',amount:'400',paymentDate:'2026-11-03',fundingAccountId:account.id});
 costs=await f.expenses.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'});
 assert.equal(costs.expenses.length,1);assert.equal((costs.expenses[0] as Record<string,unknown>).paidMinor,'60000');
 const finance=await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'});assert.equal(Number(finance.totals[0].balance),600);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.expense_funding_links')).rows.length,2);
});

test('funding failure rolls back bill/payment; pending cheque and wrong-currency account cannot move money',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01'});
 const body={action:'record-expense',propertyId:f.p.id,category:'cleaning',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}};
 await assert.rejects(f.expense(body));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.property_expenses')).rows.length,0);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.expense_payments')).rows.length,0);
 await assert.rejects(f.expense({...body,payment:{...body.payment,method:'cheque'}}));
 await assert.rejects(f.write({action:'record-collection',agreementId:f.agreement.id,kind:'deposit',method:'cheque',amount:'2000',receivedDate:'2026-11-02',receivingAccountId:account.id,accountConfirmed:true}));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_collections')).rows.length,0);
});

test('funded deposit refund posts one outflow and preserves rent, while generic linked bill reversal is denied',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01'});
 await f.write({action:'record-collection',agreementId:f.agreement.id,kind:'deposit',method:'cash',amount:'2000',receivedDate:'2026-11-02',receivingAccountId:account.id,accountConfirmed:true});
 const body={action:'refund-deposit',agreementId:f.agreement.id,method:'cash',amount:'500',receivedDate:'2026-11-03',fundingAccountId:account.id},key=randomUUID();
 await f.write(body,key);await f.write(body,key);
 const rent=await f.rental.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'});
 assert.equal((rent.summary.currencies[0] as Record<string,unknown>).depositMinor,'150000');assert.equal((rent.summary.currencies[0] as Record<string,unknown>).outstandingMinor,'200000');
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'})).totals[0].balance),1500);
 await f.expense({action:'record-expense',propertyId:f.p.id,category:'maintenance',expenseDate:'2026-11-03',amount:'100',currency:'XTS',vendorName:'Synthetic vendor',payment:{method:'cash',amount:'100',paymentDate:'2026-11-03',fundingAccountId:account.id}});
 const link=(await f.pg.query<{entry_id:string}>('SELECT entry_id FROM hamdee_private.expense_funding_links')).rows[0];
 await assert.rejects(f.writeFinance({action:'reverse',entryId:link.entry_id,reversedOn:'2026-11-03',reason:'Synthetic inappropriate standalone funding reversal'}));
});
