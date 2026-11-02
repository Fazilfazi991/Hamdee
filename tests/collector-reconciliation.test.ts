import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {ReconciliationService} from '../src/reconciliation';
async function setup(t:test.TestContext){const f=await operationsFixture();t.after(()=>f.pg.close());for(const name of ['015_local_account_reconciliation.up.sql','018_local_collector_counts.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));return {...f,reconciliation:new ReconciliationService(f.properties)};}

test('collector actual counts preserve exact snapshot, unknown opening and differences without cash adjustments',async t=>{
 const f=await setup(t),collector=await f.collector(),receipt=await f.receipt({amount:'1200'});await f.collect(collector.id,receipt.id);
 const key=randomUUID(),body={action:'record-collector-reconciliation',collectorId:collector.id,currency:'XTS',reconciledOn:'2026-10-16',countedBalance:'1199.123456789123',explanation:'Synthetic declared count; unresolved difference retained'};
 const count=await f.reconciliation.mutate(f.identity,body,key,randomUUID());assert.equal(count.data.calculatedBalance,'1200');assert.equal(Number(count.data.difference),-0.876543210877);assert.equal(count.data.openingConfirmed,false);
 assert.equal((await f.reconciliation.mutate(f.identity,body,key,randomUUID())).replay,true);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,1);
 const later=await f.receipt({amount:'10',receivedOn:'2026-10-14'});await f.collect(collector.id,later.id);
 const history=await f.reconciliation.overview(f.identity,{asOf:'2026-10-16'});assert.equal(history.collectorRecords.length,1);assert.equal(history.collectorRecords[0].calculatedBalance,'1200');assert.equal(history.collectorRecords[0].currentCalculatedBalance,'1210');
 await assert.rejects(f.reconciliation.overview({issuer:f.identity.issuer,subject:f.users.reader.subject},{asOf:'2026-10-16'}));
});

test('confirmed collector opening is currency-specific and never a new collection or handover',async t=>{
 const f=await setup(t),collector=await f.collector();
 const body={action:'confirm-collector-opening',collectorId:collector.id,currency:'XTS',openingDate:'2026-10-01',openingAmount:'9800',method:'cash',ownerConfirmedOpening:true,sourceReference:'Synthetic explicit opening',notes:''};
 await f.reconciliation.mutate(f.identity,body,randomUUID(),randomUUID());
 await assert.rejects(f.reconciliation.mutate(f.identity,body,randomUUID(),randomUUID()));
 await assert.rejects(f.reconciliation.mutate(f.identity,{...body,currency:'USD',ownerConfirmedOpening:false},randomUUID(),randomUUID()));
 const report=await f.staff.overview(f.identity,{month:'2026-10',asOf:'2026-10-16'});assert.equal(Number(report.totals[0].balance),9800);assert.equal(Number(report.totals[0].received),0);assert.equal(Number(report.totals[0].handedOver),0);
 const account=await f.account();await f.handover(collector.id,account.id,{amount:'9426'});assert.equal(Number((await f.staff.overview(f.identity,{month:'2026-10',asOf:'2026-10-16'})).totals[0].balance),374);
 const count=await f.reconciliation.mutate(f.identity,{action:'record-collector-reconciliation',collectorId:collector.id,currency:'XTS',reconciledOn:'2026-10-16',countedBalance:'374',explanation:'Synthetic matching count'},randomUUID(),randomUUID());assert.equal(count.data.openingConfirmed,true);assert.equal(Number(count.data.difference),0);
 await assert.rejects(f.collect(collector.id,(await f.receipt({receivedOn:'2026-09-30'})).id));
});

test('optional physical cash denominations remain separate from bank holdings and cannot alter balances',async t=>{
 const f=await setup(t),account=await f.account({openingAmount:'7000'}),bank=await f.account({kind:'bank',openingAmount:'7000'});
 const body={action:'record-reconciliation',accountId:account.id,reconciledOn:'2026-10-15',countedBalance:'7000',explanation:'Synthetic fourteen notes',denominations:[{denomination:'500',quantity:14}]};
 await f.reconciliation.mutate(f.identity,body,randomUUID(),randomUUID());
 await assert.rejects(f.reconciliation.mutate(f.identity,{...body,denominations:[{denomination:'500',quantity:13}]},randomUUID(),randomUUID()));
 await assert.rejects(f.reconciliation.mutate(f.identity,{...body,accountId:bank.id},randomUUID(),randomUUID()));
 const record=(await f.reconciliation.overview(f.identity,{asOf:'2026-10-15',accountId:String(account.id)})).records[0];assert.deepEqual(record.countDetails,[{denomination:'500',quantity:14}]);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,2);
});
