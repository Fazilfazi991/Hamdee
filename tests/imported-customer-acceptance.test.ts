import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {CustomerService} from '../src/customers';
import {CarRentalService} from '../src/car-rentals';
import {DocumentService} from '../src/documents';
import {SupportingRecordService} from '../src/supporting-records';
type Row=Record<string,unknown>;
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());
 for(const file of ['007_local_car_rentals.up.sql','011_local_owner_occupancy.up.sql','012_local_private_documents.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','016_local_scoped_expenses.up.sql','017_local_corrections_and_source_compatibility.up.sql','019_local_principal_supporting_records.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const customers=new CustomerService(f.properties),cars=new CarRentalService(f.properties),documents=new DocumentService(f.properties),supporting=new SupportingRecordService(f.properties);
 const rental=async(body:unknown)=>(await f.rental.mutate(f.identity,body,randomUUID(),randomUUID()) as {data:Row}).data;
 const customer=async(body:unknown)=>(await customers.mutate(f.identity,body,randomUUID(),randomUUID()) as {data:Row}).data;
 const car=async(body:unknown)=>(await cars.mutate(f.identity,body,randomUUID(),randomUUID())).data as unknown as Row;
 return {...f,customers,cars,documents,supporting,rent:rental,customer,car};
}

test('sanitized imported monthly identities stay distinct while customer history survives occupancy change, KYC and optional documents',async t=>{
 const f=await setup(t),property=await f.create('admin','Synthetic imported villa'),other=await f.create('admin','Synthetic other villa');
 const room=await f.rent({action:'create-room',propertyId:property.id,code:'SYN-37TH'}),otherRoom=await f.rent({action:'create-room',propertyId:other.id,code:'SYN-37TH'});
 assert.notEqual(room.id,otherRoom.id);
 const old=await f.rent({action:'create-tenant',name:'Synthetic duplicate name',phone:'SYN-OLD',notes:'October2026 source snapshot only. Occupancy and agreement terms unverified. Synthetic imported villa / SYN-37TH (SL 2, PDF p1; AMOUNT=2000; R DATE=5)'}),duplicate=await f.rent({action:'create-tenant',name:'Synthetic duplicate name',phone:'SYN-DUPLICATE'}),next=await f.rent({action:'create-tenant',name:'Synthetic November occupant',phone:'SYN-NOV'});
 const sourceBefore=await f.rental.overview(f.identity,{month:'2026-10',asOf:'2026-10-01'});const sourceRoom=sourceBefore.rooms.find(row=>(row as Row).id===room.id)!;
 assert.equal(sourceRoom.occupancy,'unknown');assert.equal(sourceRoom.historicalOccupants[0].tenantId,old.id);assert.equal(sourceBefore.agreements.length,0);assert.equal(sourceBefore.collections.length,0);
 await f.supporting.mutate(f.identity,{action:'create-reference',kind:'other-reference',label:'Synthetic November source occupant reference',propertyId:property.id,roomId:room.id,customerId:next.id,sourceReference:'Synthetic November source cell',originalWording:'Synthetic November name differs from October; review Q07',details:{sourceDateReference:'November2026 source snapshot'},reviewQuestions:['Q07','Q08'],status:'unconfirmed'},randomUUID(),randomUUID());
 const identity=await f.customer({action:'update-kyc',customerId:old.id,expectedVersion:0,kyc:{identityName:'Synthetic private name',documentType:'Other',documentNumber:'SYNTHETIC-IDENTITY-ONLY'},reason:'Synthetic imported customer owner review still pending'});assert.equal(identity.status,'pending-review');
 const bytes=Buffer.from('%PDF-1.4\n% synthetic private identity\n%%EOF');await f.customer({action:'upload-kyc',customerId:old.id,name:'Synthetic identity.pdf',mimeType:'application/pdf',side:'front',base64:bytes.toString('base64')});
 const propertyDoc=await f.documents.upload(f.identity,{propertyId:property.id,roomId:room.id,name:'Synthetic optional room.pdf',mimeType:'application/pdf',base64:Buffer.from('%PDF-1.4\n% synthetic optional supporting file\n%%EOF').toString('base64')},randomUUID());
 await f.documents.upload(f.identity,{propertyId:other.id,roomId:otherRoom.id,name:'Synthetic unrelated private room.pdf',mimeType:'application/pdf',base64:bytes.toString('base64')},randomUUID());
 const terms=await f.rent({action:'create-agreement',roomId:room.id,tenantId:old.id,startDate:'2026-10-01',endDate:'2026-10-31',monthlyRent:'2000',currency:'XTS',depositRequired:'500',dueTerms:'Explicit October due date'}),due=await f.rent({action:'issue-due',agreementId:terms.id,period:'2026-10',dueDate:'2026-10-05',amount:'2000'}),account=await f.account({openingDate:'2026-10-01'});
 await f.rent({action:'record-collection',agreementId:terms.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-10-10',allocations:[{dueId:due.id,amount:'1200'}],receivingAccountId:account.id,accountConfirmed:true});
 await f.rent({action:'record-collection',agreementId:terms.id,kind:'deposit',method:'cash',amount:'500',receivedDate:'2026-10-10',receivingAccountId:account.id,accountConfirmed:true});
 await f.customer({action:'record-security-cheque',customerId:old.id,agreementId:terms.id,chequeNumber:'SYN-HELD',bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-10-10',receivedDate:'2026-10-10',amount:'2000',currency:'XTS'});
 const confirmation=await f.rent({action:'confirm-occupancy',roomId:room.id,tenantId:next.id,status:'occupied',effectiveDate:'2026-11-01',expectedOccupancyVersion:0,notes:'Synthetic explicit reviewed new occupant',terms:{monthlyRent:'2100',currency:'XTS',depositRequired:'0',dueTerms:'Explicit November due date'}});
 await f.rent({action:'issue-due',agreementId:confirmation.internalAgreementId,period:'2026-11',dueDate:'2026-11-05',amount:'2100'});
 const oldProfile=await f.customers.profile(f.identity,old.id,{asOf:'2026-11-30'}),newProfile=await f.customers.profile(f.identity,next.id,{asOf:'2026-11-30'});
 assert.equal(oldProfile.customer.balances[0].outstandingMinor,'80000');assert.equal(oldProfile.customer.balances[0].depositMinor,'50000');assert.equal(oldProfile.customer.balances[0].securityChequeMinor,'200000');assert.equal(newProfile.customer.balances[0].outstandingMinor,'210000');
 assert.equal(oldProfile.collections.length,2);assert.equal(oldProfile.kyc.status,'pending-review');assert.equal(oldProfile.kyc.documents.length,1);assert.equal(oldProfile.propertyDocuments.length,1);assert.equal(oldProfile.propertyDocuments[0].id,propertyDoc.data.id);assert.doesNotMatch(JSON.stringify(oldProfile),/SYNTHETIC-IDENTITY-ONLY|synthetic private identity|unrelated private room/);
 assert.deepEqual((await f.customers.getDocument(f.identity,oldProfile.kyc.documents[0].id)).content,bytes);
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),1700);
 const november=await f.rental.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'});assert.equal(november.rooms.find(row=>(row as Row).id===room.id)?.currentTenantId,next.id);assert.equal((await f.customers.profile(f.identity,duplicate.id,{asOf:'2026-11-30'})).properties.length,0);
 const list=await f.customers.overview(f.identity,{asOf:'2026-11-30',q:'Synthetic duplicate name'});assert.equal(list.customers.length,2);assert.ok(list.customers.every(row=>row.potentialDuplicate));assert.equal((await f.pg.query('SELECT * FROM hamdee_private.tenants')).rows.length,3);
});

test('explicit canonical customer car linking preserves snapshot labels and source-only vehicle evidence without fabricated receipt',async t=>{
 const f=await setup(t),p=await f.create('admin','Synthetic combined villa'),room=await f.rent({action:'create-room',propertyId:p.id,code:'SYN-BOTH'}),customer=await f.rent({action:'create-tenant',name:'Synthetic canonical contact'}),duplicate=await f.rent({action:'create-tenant',name:'Synthetic canonical contact'});
 await f.rent({action:'create-agreement',roomId:room.id,tenantId:customer.id,startDate:'2026-11-01',monthlyRent:'1000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit confirmed November amount'});
 const vehicle=await f.car({action:'create-vehicle',registration:'SYN-CANONICAL',make:'Synthetic',model:'Synthetic confirmed vehicle',status:'active'}),agreement=await f.car({action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic immutable external label',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'900.123456',currency:'XTS',billingPeriod:'Explicit synthetic vehicle term'});
 await f.customer({action:'link-car',customerId:customer.id,agreementId:agreement.id,reason:'Synthetic owner explicitly reviewed source identity'});
 await assert.rejects(f.customer({action:'link-car',customerId:duplicate.id,agreementId:agreement.id,reason:'Synthetic conflicting name-only link'}));
 const account=await f.account({openingDate:'2026-11-01'}),key=randomUUID(),receipt={action:'record-collection',agreementId:agreement.id,receiptKey:randomUUID(),receivedDate:'2026-11-02',amount:'100.000001',currency:'XTS',method:'cash',receivingAccountId:account.id,accountConfirmed:true};
 await f.cars.mutate(f.identity,receipt,key,randomUUID());assert.equal((await f.cars.mutate(f.identity,receipt,key,randomUUID())).replay,true);
 const candidate=await f.car({action:'create-vehicle',registration:null,make:null,model:'Synthetic unresolved vehicle mention',status:'needs_confirmation',sourceKey:'synthetic/source/fleet/candidate',sourceReference:'Synthetic unknown-date source cell'});
 await f.car({action:'add-source-reference',vehicleId:candidate.id,sourceKey:'synthetic/source/fleet/reference',sourceReference:'Synthetic additional source line',amountReference:'Unconfirmed historical amount / period'});
 const profile=await f.customers.profile(f.identity,customer.id,{asOf:'2026-11-30'});assert.equal(profile.carRentals.length,1);assert.equal((profile.carRentals[0] as Row).customerName,'Synthetic immutable external label');assert.equal(profile.customer.balances[0].carOutstandingAmount,'800.123455');assert.equal(profile.properties.length,1);
 assert.equal((await f.customers.profile(f.identity,duplicate.id,{asOf:'2026-11-30'})).carRentals.length,0);
 const list=await f.customers.overview(f.identity,{asOf:'2026-11-30'});assert.equal(list.customers.find(row=>(row as Row).id===customer.id)?.customerType,'both');
 const cars=await f.cars.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'});assert.equal(cars.vehicles.find(row=>row.id===candidate.id)?.registration,null);assert.equal(cars.availability.find(row=>row.vehicleId===candidate.id)?.available,false);assert.equal(cars.collections.length,1);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.car_source_references')).rows.length,2);
 assert.equal((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals.find(row=>row.accountId===account.id)?.balance,'100.000001');assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_claims')).rows.length,1);
 await assert.rejects(f.car({action:'create-agreement',vehicleId:candidate.id,agreementKey:randomUUID(),customerName:'Synthetic denied source-only rental',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'100',currency:'XTS',billingPeriod:'Unconfirmed source'}));
});
