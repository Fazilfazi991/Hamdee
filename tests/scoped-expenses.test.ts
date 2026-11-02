import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {ExpenseService} from '../src/expenses';
import {DailyDashboardService} from '../src/daily-dashboard';
type Row=Record<string,unknown>;
const query={month:'2026-11',asOf:'2026-11-30'};
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());
 for(const file of ['014_local_connected_funding.up.sql','016_local_scoped_expenses.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const expenses=new ExpenseService(f.properties);
 const write=async(body:unknown,key=randomUUID())=>await expenses.mutate(f.identity,body,key,randomUUID()) as {data:Row;replay:boolean};
 const bill=(scope='company',extra:Row={})=>({action:'record-expense',scope,category:'company_overhead',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic scoped vendor',...extra});
 return {...f,expenses,write,bill};
}
test('company bill stays unpaid until actual payments; one save funds partial payment and later settlement keeps one bill',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01',openingAmount:'1000'});
 const key=randomUUID(),body=f.bill('company',{payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}});
 const first=await f.write(body,key);assert.equal((await f.write(body,key)).replay,true);
 let report=await f.expenses.overview(f.identity,query);
 assert.equal(report.expenses.length,1);assert.equal((report.expenses[0] as Row).scope,'company');assert.equal((report.expenses[0] as Row).outstandingMinor,'40000');
 assert.equal(report.summary.properties.length,0);assert.equal(report.summary.currencies.length,0);
 assert.equal(report.scopedSummary[0].recordedMinor,'60000');assert.equal(report.scopedSummary[0].paidMinor,'20000');
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),800);
 await f.write({action:'record-payment',expenseId:first.data.id,method:'cash',amount:'400',paymentDate:'2026-11-03',fundingAccountId:account.id});
 report=await f.expenses.overview(f.identity,query);assert.equal(report.expenses.length,1);assert.equal((report.expenses[0] as Row).outstandingMinor,'0');
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),400);
 const unpaid=await f.write(f.bill('company',{amount:'50',reference:'SYNTHETIC-UNPAID'}));assert.ok(unpaid.data.id);
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),400);
});
test('personal bill debits actual company funding without entering company or property operating cost totals',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01',openingAmount:'1000'});
 await f.write(f.bill('company',{amount:'100'}));
 await f.write(f.bill('personal',{amount:'90',payment:{method:'cash',amount:'90',paymentDate:'2026-11-02',fundingAccountId:account.id}}));
 const report=await f.expenses.overview(f.identity,query);assert.equal(report.summary.properties.length,0);
 assert.equal(report.scopedSummary.find(r=>r.scope==='company')?.recordedMinor,'10000');
 assert.equal(report.scopedSummary.find(r=>r.scope==='personal')?.recordedMinor,'9000');
 const dashboard=await new DailyDashboardService(f.properties).overview(f.identity,query) as Row;
 assert.equal(((dashboard.overview as Row).currencies as Row[])[0].monthlyExpenses,'100');
 assert.equal((dashboard.expenses as Row[])[0].recorded,'100');
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),910);
 const entries=(await f.pg.query<Row>("SELECT classification FROM hamdee_private.ops_money WHERE entry_kind='expense'")).rows;assert.equal(entries[0].classification,'personal-expense');
});
test('scoped bill guards preserve invoice uniqueness, currency and atomic rollback',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01',openingAmount:'0'});
 await assert.rejects(f.write(f.bill('company',{payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}})));
 assert.equal((await f.pg.query('SELECT id FROM hamdee_private.property_expenses')).rows.length,0);
 await assert.rejects(f.write(f.bill('personal',{propertyId:randomUUID()})));
 const original=await f.write(f.bill('company',{reference:'SYNTHETIC-INV'}));
 await assert.rejects(f.write(f.bill('company',{reference:'SYNTHETIC-INV'})));
 await f.write(f.bill('personal',{reference:'SYNTHETIC-INV'}));
 await assert.rejects(f.write({action:'record-payment',expenseId:original.data.id,method:'cash',amount:'601',paymentDate:'2026-11-03'}));
 await assert.rejects(f.pg.transaction(async tx=>{
   await tx.query("INSERT INTO hamdee_private.expense_payments(id,expense_id,property_id,method,amount_minor,payment_date,status,event_id) VALUES($1,$2,$3,'cash',1,'2026-11-03','recorded',$4)",[randomUUID(),original.data.id,randomUUID(),randomUUID()]);
 }));
});
