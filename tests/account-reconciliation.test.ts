import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {operationsFixture} from './support/operations-fixture';
import {ReconciliationService} from '../src/reconciliation';

test('dated reconciliation records exact difference once without moving money; later backdated entry retains original count',async t=>{
 const f=await operationsFixture();t.after(()=>f.pg.close());await f.pg.exec(await readFile(new URL('../migrations/015_local_account_reconciliation.up.sql',import.meta.url),'utf8'));
 const service=new ReconciliationService(f.properties),account=await f.account({openingAmount:'100.123456789123'}),key=randomUUID();
 const body={action:'record-reconciliation',accountId:account.id,reconciledOn:'2026-10-15',countedBalance:'90.123456789123',explanation:'Synthetic counted difference awaiting review'};
 const first=await service.mutate(f.identity,body,key,randomUUID());assert.equal(first.data.difference,'-10.000000000000');
 assert.equal((await service.mutate(f.identity,body,key,randomUUID())).replay,true);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,1);
 const receipt=await f.receipt({receivedOn:'2026-10-14',amount:'20'});await f.writeFinance({action:'receive',accountId:account.id,sourceKind:'classified-receipt',sourceId:receipt.id,ownerConfirmedDisposition:true});
 const read=await service.overview(f.identity,{asOf:'2026-10-16',accountId:String(account.id)});assert.equal(read.records.length,1);
 assert.equal(read.records[0].calculatedBalance,'100.123456789123');assert.equal(read.records[0].currentCalculatedBalance,'120.123456789123');
 assert.equal((await service.overview(f.identity,{asOf:'2026-10-14'})).records.length,0);
 await assert.rejects(service.mutate(f.identity,{...body,countedBalance:'100'},key,randomUUID()));
 await assert.rejects(service.mutate(f.identity,{...body,explanation:''},randomUUID(),randomUUID()));
 await assert.rejects(service.overview({issuer:f.identity.issuer,subject:f.users.reader.subject},{asOf:'2026-10-16'}));
 await assert.rejects(f.pg.exec('SET ROLE hamdee_runtime; DELETE FROM hamdee_private.account_reconciliations'));
});
