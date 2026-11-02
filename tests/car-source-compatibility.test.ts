import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {operationsFixture} from './support/operations-fixture';
import {CarRentalService} from '../src/car-rentals';
import {DocumentService} from '../src/documents';
type Row=Record<string,unknown>;
const migration=(name:string)=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');

test('populated pre-candidate car013 upgrade preserves occupancy, private documents, source vehicle references, IDs, money and old migrations',async t=>{
 const f=await operationsFixture();t.after(()=>f.pg.close());
 for(const name of ['007_local_car_rentals.up.sql','011_local_owner_occupancy.up.sql','012_local_private_documents.up.sql'])await f.pg.exec(await migration(name));
 await f.pg.exec(await readFile(new URL('./support/legacy-car-source-013.sql',import.meta.url),'utf8'));
 const cars=new CarRentalService(f.properties),car=async(b:unknown)=>(await cars.mutate(f.identity,b,randomUUID(),randomUUID())).data as unknown as Row;
 const source=await car({action:'create-vehicle',registration:null,make:null,model:'Synthetic unknown source vehicle',status:'needs_confirmation',sourceKey:'synthetic/workbook/cell',sourceReference:'Synthetic source only; no historical posting'});
 await car({action:'add-source-reference',vehicleId:source.id,sourceKey:'synthetic/other/cell',sourceReference:'Synthetic unposted amount reference',amountReference:'250'});
 const vehicle=await f.account({openingAmount:'100'}),p=await f.create(),rental=async(b:unknown)=>(await f.rental.mutate(f.identity,b,randomUUID(),randomUUID()) as {data:Row}).data;
 const room=await rental({action:'create-room',propertyId:p.id,code:'PRESERVE'}),tenant=await rental({action:'create-tenant',name:'Synthetic preserved occupant'});
 await rental({action:'confirm-occupancy',roomId:room.id,tenantId:tenant.id,status:'occupied',effectiveDate:'2026-11-01',expectedOccupancyVersion:0,notes:'Synthetic occupancy without formal file'});
 const terms=await rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-01',monthlyRent:'100',depositRequired:'50',currency:'XTS',dueTerms:'Synthetic populated prior terms'});
 await rental({action:'record-collection',agreementId:terms.id,kind:'deposit',method:'cash',amount:'50',receivedDate:'2026-11-02',receivingAccountId:vehicle.id,accountConfirmed:true});
 const oldRefund=await rental({action:'refund-deposit',agreementId:terms.id,method:'cash',amount:'20',receivedDate:'2026-11-03',fundingAccountId:vehicle.id});
 const documents=new DocumentService(f.properties),bytes=Buffer.from('%PDF-1.4\n% synthetic optional property document\n%%EOF');
 const document=await documents.upload(f.identity,{propertyId:p.id,roomId:room.id,name:'Synthetic optional.pdf',mimeType:'application/pdf',base64:bytes.toString('base64')},randomUUID());
 for(const name of ['013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','015_local_account_reconciliation.up.sql','016_local_scoped_expenses.up.sql'])await f.pg.exec(await migration(name));
 const tables=['properties','property_revisions','tenants','rooms','room_occupancy_confirmations','property_documents','car_vehicles','car_vehicle_revisions','car_source_references','rental_agreements','rent_collections','ops_accounts','ops_money','ops_events'];
 const snapshot=async()=>Promise.all(tables.map(async table=>(await f.pg.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM hamdee_private.${table} t`)).rows));
 const before=await snapshot(),upgrade=await migration('017_local_corrections_and_source_compatibility.up.sql');await f.pg.transaction(tx=>tx.exec(upgrade));assert.deepEqual(await snapshot(),before);
 const overview=await cars.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'}) as unknown as {sourceAvailable:boolean;sourceReferences:Row[];vehicles:Row[];availability:Row[]};
 assert.equal(overview.sourceAvailable,true);assert.equal(overview.sourceReferences.length,2);assert.equal(overview.vehicles[0].id,source.id);assert.equal(overview.availability[0].available,false);
 assert.deepEqual((await documents.get(f.identity,document.data.id)).content,bytes);assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals.find(row=>row.accountId===vehicle.id)?.balance),130);
 assert.equal((await f.pg.query<{collection_id:string}>('SELECT collection_id FROM hamdee_private.rental_refund_funding_links')).rows[0].collection_id,oldRefund.id);
 await assert.rejects(f.pg.transaction(tx=>tx.exec(upgrade)));assert.deepEqual(await snapshot(),before);
});

test('new source vehicles remain unposted and provenance is owner-only, immutable and duplicate-key safe',async t=>{
 const f=await operationsFixture();t.after(()=>f.pg.close());for(const name of ['007_local_car_rentals.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','016_local_scoped_expenses.up.sql','017_local_corrections_and_source_compatibility.up.sql'])await f.pg.exec(await migration(name));
 const cars=new CarRentalService(f.properties),body={action:'create-vehicle',registration:null,make:null,model:'Synthetic unconfirmed car',status:'needs_confirmation',sourceKey:'synthetic/source/one',sourceReference:'Synthetic exact source reference'},key=randomUUID();
 const first=await cars.mutate(f.identity,body,key,randomUUID());assert.equal((await cars.mutate(f.identity,body,key,randomUUID())).replay,true);
 await assert.rejects(cars.mutate(f.identity,{...body,model:'Other synthetic model'},randomUUID(),randomUUID()));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.car_receipts')).rows.length,0);
 await assert.rejects(cars.mutate(f.identity,{action:'create-agreement',vehicleId:first.data.id,agreementKey:randomUUID(),customerName:'Synthetic customer',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'100',currency:'XTS',billingPeriod:'Explicit total'},randomUUID(),randomUUID()));
 await assert.rejects(f.pg.exec('UPDATE hamdee_private.car_source_references SET amount_reference=\'999\''));
});

test('car collection saves precise receipt and selected account or custody once; pending/mismatched locations roll back',async t=>{
 const f=await operationsFixture();t.after(()=>f.pg.close());await f.pg.exec(await migration('007_local_car_rentals.up.sql'));
 const cars=new CarRentalService(f.properties),write=(b:unknown,key=randomUUID())=>cars.mutate(f.identity,b,key,randomUUID());
 const vehicle=(await write({action:'create-vehicle',registration:'SYN-FUNDED',make:'Synthetic',model:'Synthetic precise funded car',status:'active'})).data;
 const terms=(await write({action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic funded car customer',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'1000.123456789123',currency:'XTS',billingPeriod:'Explicit total'})).data;
 const bank=await f.account({kind:'bank',openingDate:'2026-11-01'}),collector=await f.collector(),key=randomUUID(),body={action:'record-collection',agreementId:terms.id,receiptKey:randomUUID(),receivedDate:'2026-11-02',amount:'120.123456789123',currency:'XTS',method:'bank',receivingAccountId:bank.id,accountConfirmed:true};
 await write(body,key);assert.equal((await write(body,key)).replay,true);
 await write({...body,receiptKey:randomUUID(),amount:'80',method:'cash',receivingAccountId:undefined,receivingCollectorId:collector.id});
 await f.handover(collector.id,bank.id,{amount:'50',currency:'XTS',handedOn:'2026-11-03'});
 assert.equal((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance,'170.123456789123');assert.equal(Number((await f.staff.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),30);
 const wrong=await f.account({kind:'bank',currency:'USD'});
 await assert.rejects(write({...body,receiptKey:randomUUID(),method:'cheque'}));await assert.rejects(write({...body,receiptKey:randomUUID(),receivingAccountId:wrong.id}));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.car_receipts')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_claims')).rows.length,2);
});
