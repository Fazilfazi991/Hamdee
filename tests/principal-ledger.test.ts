import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {operationsFixture} from './support/operations-fixture';
import {PrincipalService} from '../src/principal';
type Row=Record<string,unknown>;
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());for(const name of ['007_local_car_rentals.up.sql','014_local_connected_funding.up.sql','019_local_principal_supporting_records.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const principal=new PrincipalService(f.properties),write=(body:unknown,key=randomUUID())=>principal.mutate(f.identity,body,key,randomUUID());return {...f,principal,write};
}
const create=(fields:Row={})=>({action:'create-obligation',direction:'receivable',kind:'loan',counterparty:'Synthetic counterparty',amount:'2000',currency:'XTS',openedOn:'2026-11-01',...fields});
test('principal openings are not cash and both directions retain distinct partial repayment histories',async t=>{
 const f=await setup(t),a=await f.account({openingDate:'2026-11-01',openingAmount:'1000'}),receivable=(await f.write(create())).data,payable=(await f.write(create({direction:'payable',amount:'600'}))).data;
 const key=randomUUID(),receipt={action:'repay',obligationId:receivable.id,amount:'1200',paidOn:'2026-11-02',method:'cash',accountId:a.id};await f.write(receipt,key);assert.equal((await f.write(receipt,key)).replay,true);
 await f.write({action:'repay',obligationId:payable.id,amount:'200',paidOn:'2026-11-03',method:'cash',accountId:a.id});
 const read=await f.principal.overview(f.identity,{asOf:'2026-11-03'});assert.equal(read.obligations.find(o=>o.id===receivable.id)?.outstandingAmount,'800');assert.equal(read.obligations.find(o=>o.id===payable.id)?.outstandingAmount,'400');assert.equal(read.totals.length,2);
 const finance=await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'});assert.equal(Number(finance.totals[0].balance),2000);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_collections')).rows.length,0);
 assert.equal((await f.principal.overview(f.identity,{asOf:'2026-11-01'})).movements.length,0);
 await assert.rejects(f.write({...receipt,amount:'801',paidOn:'2026-11-04'}));
 await assert.rejects(f.principal.overview({issuer:f.identity.issuer,subject:f.users.reader.subject},{asOf:'2026-11-03'}));
});
test('principal corrections compensate money once, preserve earlier cutoffs and prevent generic reversal/re-receiving',async t=>{
 const f=await setup(t),collector=await f.collector(),account=await f.account({openingDate:'2026-11-01'}),o=(await f.write(create())).data;
 const payment=(await f.write({action:'repay',obligationId:o.id,amount:'1200',paidOn:'2026-11-02',method:'cash',collectorId:collector.id})).data;
 await assert.rejects(f.writeFinance({action:'reverse',entryId:payment.moneyEntryId,reversedOn:'2026-11-03',reason:'Synthetic denied standalone reversal'}));
 const correction={action:'correct-repayment',movementId:payment.id,correctedOn:'2026-11-03',reason:'Synthetic wrong amount',replacement:{amount:'1000',paidOn:'2026-11-03',method:'cash',collectorId:collector.id}},key=randomUUID();
 await f.write(correction,key);assert.equal((await f.write(correction,key)).replay,true);await assert.rejects(f.write(correction));
 assert.equal((await f.principal.overview(f.identity,{asOf:'2026-11-02'})).obligations[0].outstandingAmount,'800');assert.equal((await f.principal.overview(f.identity,{asOf:'2026-11-03'})).obligations[0].outstandingAmount,'1000');
 const staff=await f.staff.overview(f.identity,{month:'2026-11',asOf:'2026-11-03'});assert.equal(Number(staff.totals[0].balance),1000);assert.equal(staff.collections.filter(c=>c.reversed).length,1);
 await f.handover(collector.id,account.id,{amount:'1000',handedOn:'2026-11-04'});
 const replacement=(await f.principal.overview(f.identity,{asOf:'2026-11-04'})).movements.find(m=>m.replacesId===payment.id)!;
 await assert.rejects(f.write({action:'correct-repayment',movementId:replacement.id,correctedOn:'2026-11-05',reason:'Synthetic dependent handover prevents reversal'}));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.principal_corrections')).rows.length,1);
});
test('principal funding is explicit, exact decimal precision survives and principal corrections do not invent funds',async t=>{
 const f=await setup(t),a=await f.account({openingAmount:'1000',openingDate:'2026-11-01'});
 const o=(await f.write(create({direction:'receivable',amount:'100.123456789123',fundingAccountId:a.id,method:'cash',fundedOn:'2026-11-01'}))).data;
 await f.write({action:'repay',obligationId:o.id,amount:'0.123456789123',paidOn:'2026-11-02',method:'cash',accountId:a.id});
 let state=await f.principal.overview(f.identity,{asOf:'2026-11-02'});assert.equal(state.obligations[0].outstandingAmount,'100.000000000000');
 await f.write({action:'correct-obligation',obligationId:o.id,expectedVersion:1,amount:'150.123456789123',correctedOn:'2026-11-03',reason:'Synthetic corrected opening principal only'});
 state=await f.principal.overview(f.identity,{asOf:'2026-11-03'});assert.equal(state.obligations[0].outstandingAmount,'150.000000000000');assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,3);
 await assert.rejects(f.write({action:'correct-obligation',obligationId:o.id,expectedVersion:2,amount:'0.01',correctedOn:'2026-11-04',reason:'Synthetic invalid principal reduction'}));
 await assert.rejects(f.write(create({currency:'USD',fundingAccountId:a.id,method:'cash',fundedOn:'2026-11-01'})));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.principal_obligations')).rows.length,1);
});
