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
 for(const migration of ['014_local_connected_funding.up.sql','016_local_scoped_expenses.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const expenses=new ExpenseService(f.properties);
 const write=async(body:unknown,key=randomUUID())=>await expenses.mutate(f.identity,body,key,randomUUID()) as {data:Row;replay:boolean};
 const bill=(scope:string,extra:Row={})=>({action:'record-expense',scope,category:'company_overhead',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic independent scope QA',...extra});
 return {...f,expenses,write,bill};
}

test('independent scopes QA: unpaid company bill, partial payment and later-month settlement keep actual money and cost dates separate',async t=>{
 const f=await setup(t),account=await f.account({openingAmount:'1000',openingDate:'2026-11-01'});
 const original=await f.write(f.bill('company'));
 const balance=async(asOf:string)=>Number((await f.finance.overview(f.identity,{month:'2026-11',asOf})).totals[0].balance);
 assert.equal(await balance('2026-11-02'),1000);
 let costs=await f.expenses.overview(f.identity,{month:'2026-11',asOf:'2026-11-02'});
 assert.deepEqual(costs.scopedSummary,[{scope:'company',currency:'XTS',recordedMinor:'60000',paidMinor:'0',outstandingMinor:'60000',pendingChequeMinor:'0'}]);
 const key=randomUUID(),partial={action:'record-payment',expenseId:original.data.id,method:'cash',amount:'200',paymentDate:'2026-11-05',fundingAccountId:account.id};
 const results=await Promise.all([f.write(partial,key),f.write(partial,key)]);assert.equal(results.filter(r=>r.replay).length,1);
 assert.equal(await balance('2026-11-04'),1000);assert.equal(await balance('2026-11-05'),800);
 costs=await f.expenses.overview(f.identity,query);assert.equal(costs.expenses.length,1);assert.equal(costs.scopedSummary[0].outstandingMinor,'40000');assert.equal(costs.scopedSummary[0].paidMinor,'20000');
 await f.write({...partial,amount:'400',paymentDate:'2026-12-01'});
 costs=await f.expenses.overview(f.identity,{month:'2026-12',asOf:'2026-12-01'});assert.equal(costs.expenses.length,1);assert.equal(costs.scopedSummary[0].recordedMinor,'0');assert.equal(costs.scopedSummary[0].paidMinor,'40000');assert.equal(costs.scopedSummary[0].outstandingMinor,'0');
 assert.equal(await balance('2026-12-01'),400);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.expense_funding_links')).rows.length,2);
});

test('independent scopes QA: personal bill reduces explicit bank while property report and company operating cost remain separate',async t=>{
 const f=await setup(t),property=await f.create(),account=await f.account({kind:'bank',openingAmount:'1000',openingDate:'2026-11-01'});
 await f.write(f.bill('property',{propertyId:property.id,category:'service_charge',amount:'100'}));
 await f.write(f.bill('company',{amount:'60'}));
 await f.write(f.bill('personal',{amount:'90',payment:{method:'bank',amount:'90',paymentDate:'2026-11-06',fundingAccountId:account.id}}));
 const report=await f.expenses.overview(f.identity,query);
 assert.equal(report.summary.properties.length,1);assert.equal(report.summary.properties[0].expenseMinor,'10000');assert.equal(report.summary.currencies[0].expenseMinor,'10000');
 assert.equal(report.scopedSummary.find(r=>r.scope==='company')?.recordedMinor,'6000');assert.equal(report.scopedSummary.find(r=>r.scope==='personal')?.recordedMinor,'9000');
 const dashboard=await new DailyDashboardService(f.properties).overview(f.identity,query) as Row;
 assert.equal((dashboard.expenses as Row[])[0].recorded,'160');assert.equal(((dashboard.overview as Row).currencies as Row[])[0].monthlyExpenses,'160');
 assert.equal(Number((await f.finance.overview(f.identity,query)).totals[0].balance),910);
 const personal=(await f.pg.query<Row>("SELECT classification,delta::text FROM hamdee_private.ops_money WHERE entry_kind='expense'")).rows;
 assert.deepEqual(personal,[{classification:'personal-expense',delta:'-90.00'}]);
});

test('independent scopes QA: collector-paid company bill spends custody once and handover moves remaining funds without new receipt',async t=>{
 const f=await setup(t),collector=await f.collector(),bank=await f.account({kind:'bank',openingDate:'2026-11-01'}),source=await f.receipt({amount:'1200',receivedOn:'2026-11-02'});
 await f.collect(collector.id,source.id);
 const key=randomUUID(),bill=f.bill('company',{payment:{method:'cash',amount:'200',paymentDate:'2026-11-03',fundingCollectorId:collector.id}});
 await f.write(bill,key);assert.equal((await f.write(bill,key)).replay,true);
 let custody=await f.staff.overview(f.identity,query);assert.equal(Number(custody.totals[0].balance),1000);assert.equal(Number(custody.totals[0].received),1200);
 await f.handover(collector.id,bank.id,{amount:'1000',handedOn:'2026-11-04'});
 custody=await f.staff.overview(f.identity,query);assert.equal(Number(custody.totals[0].balance),0);assert.equal(Number(custody.totals[0].received),1200);
 const money=await f.finance.overview(f.identity,query);assert.equal(Number(money.totals[0].balance),1000);assert.equal(Number(money.totals[0].receipts),0);
 const costs=await f.expenses.overview(f.identity,query);assert.equal(costs.expenses.length,1);assert.equal(costs.scopedSummary[0].outstandingMinor,'40000');assert.deepEqual(costs.summary.properties,[]);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_receipts')).rows.length,1);
});
