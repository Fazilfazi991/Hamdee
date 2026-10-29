import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { carFixture } from './support/car-fixture';
import { adapter, issuer } from './support/fixture';

test('without migration, a source-only vehicle fails closed and creates no master',async t=>{
 const f=await carFixture();t.after(()=>f.pg.close());
 await assert.rejects(f.writeCar({action:'create-vehicle',model:'SYNTHETIC-CAR',registration:null,make:null,status:'needs_confirmation',sourceKey:'synthetic/source',sourceReference:'Synthetic source'}),(e:unknown)=>(e as {code:string}).code==='CAR_SOURCE_UNAVAILABLE');
 assert.equal((await f.cars.overview(f.identity,{month:'2026-10',asOf:'2026-10-31'})).vehicles.length,0);
});

test('source vehicle masters retain unknown identity, require explicit activation and never post financial data',async t=>{
 const f=await carFixture();t.after(()=>f.pg.close());
 const migration=await readFile(new URL('../migrations/013_local_car_source_records.up.sql',import.meta.url),'utf8');
 await f.pg.transaction(tx=>tx.exec(migration));
 const command={action:'create-vehicle',model:'SYNTHETIC-CAR-A',registration:null,make:null,status:'needs_confirmation',sourceKey:'synthetic-pdf-hash/page/1/row/1',sourceReference:'Synthetic source, page 1, row 1'};
 const key=randomUUID(),created=await f.writeCar(command,key),replay=await f.writeCar(command,key);
 assert.equal(created.id,replay.id);assert.equal(created.registration,null);assert.equal(created.make,null);assert.equal(created.status,'needs_confirmation');
 await assert.rejects(f.writeCar({...command,sourceKey:'synthetic-other'}),(e:unknown)=>(e as {code:string}).code==='SOURCE_VEHICLE_REVIEW');
 await f.writeCar({action:'add-source-reference',vehicleId:created.id,sourceKey:'synthetic-pdf-hash/page/1/amount/1',sourceReference:'Synthetic historical amount reference',amountReference:'250.00'});
 await assert.rejects(f.writeCar({action:'add-source-reference',vehicleId:created.id,sourceKey:'synthetic-pdf-hash/page/1/amount/1',sourceReference:'Same source'}),(e:unknown)=>(e as {code:string}).code==='DUPLICATE_SOURCE');
 let state=await f.cars.overview(f.identity,{month:'2026-11',asOf:'2026-11-01'});
 assert.equal(state.vehicles.length,1);assert.equal(state.availability[0].available,false);assert.equal(state.availability[0].reason,'needs_confirmation');
 assert.equal(state.agreements.length,0);assert.equal(state.collections.length,0);assert.equal(state.expenses.length,0);assert.equal(state.summary.length,0);
 const refs=(state as unknown as {sourceReferences:{amountReference:string}[]}).sourceReferences;assert.equal(refs.length,2);assert(refs.some(r=>r.amountReference==='250.00'));
 await assert.rejects(f.cars.overview({issuer,subject:f.users.ops.subject},{month:'2026-11',asOf:'2026-11-01'}),(e:unknown)=>(e as {code:string}).code==='OWNER_ACCESS_DENIED');
 for(const sqlText of ['UPDATE hamdee_private.car_source_references SET amount_reference=\'1\'','DELETE FROM hamdee_private.car_source_references']){
  await assert.rejects(adapter(f.pg).transaction(async sql=>{await sql.query('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true)",[f.users.admin.id]);await sql.query(sqlText);}));
 }
 await assert.rejects(f.agreement(created.id),(e:unknown)=>(e as {code:string}).code==='VEHICLE_UNAVAILABLE');
 await f.writeCar({action:'update-vehicle',vehicleId:created.id,expectedVersion:1,status:'active'});
 state=await f.cars.overview(f.identity,{month:'2026-11',asOf:'2026-11-01'});assert.equal(state.vehicles[0].status,'active');assert.equal(state.vehicles[0].registration,null);
 const counts=await f.pg.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.car_source_references');assert.equal(counts.rows[0].n,2);
 await assert.rejects(f.pg.query('DELETE FROM hamdee_private.car_source_references'));
});

test('migration preserves existing vehicle identity, historical terms and receipt totals',async t=>{
 const f=await carFixture();t.after(()=>f.pg.close());
 const v=await f.vehicle({model:'SYNTHETIC-ALREADY-SAVED'}),a=await f.agreement(v.id,{agreedAmount:'100'});
 await f.collection(a.id,{amount:'25'});
 const query={month:'2026-10',asOf:'2026-10-31'},before=await f.cars.overview(f.identity,query);
 const migration=await readFile(new URL('../migrations/013_local_car_source_records.up.sql',import.meta.url),'utf8');
 await f.pg.transaction(tx=>tx.exec(migration));
 const after=await f.cars.overview(f.identity,query);
 assert.deepEqual(after.vehicles,before.vehicles);assert.deepEqual(after.agreements,before.agreements);
 assert.deepEqual(after.collections,before.collections);assert.deepEqual(after.summary,before.summary);assert.deepEqual(after.balances,before.balances);
 await assert.rejects(f.writeCar({action:'create-vehicle',registration:null,make:null,model:'synthetic-already-saved',status:'needs_confirmation',sourceKey:'synthetic/pdf/known',sourceReference:'Synthetic source'}),(e:unknown)=>(e as {code:string}).code==='SOURCE_VEHICLE_REVIEW');
});
