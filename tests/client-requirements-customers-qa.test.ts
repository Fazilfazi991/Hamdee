import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {CustomerService} from '../src/customers';
import {issuer} from './support/fixture';
import {CarRentalService} from '../src/car-rentals';
import {PGlite} from '@electric-sql/pglite';
import {adapter} from './support/fixture';
import {PropertyService} from '../src/service';
import {CompanyFinanceService} from '../src/company-finance';
import {ExpenseService} from '../src/expenses';

const query={asOf:'2026-11-30'};
type Row=Record<string,unknown>;

test('independent QA: customer private files, connected balances and command replay survive database and service reconstruction',async t=>{
 const f=await operationsFixture(true);let engine=f.pg;t.after(()=>engine.close());
 for(const file of ['007_local_car_rentals.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql'])await engine.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const customers=new CustomerService(f.properties),key=randomUUID(),bytes=Buffer.from('%PDF-1.4\n% synthetic persistence placeholder\n%%EOF');
 const body={action:'create-customer',name:'Synthetic retained customer',documents:[{name:'Synthetic retained.pdf',mimeType:'application/pdf',side:'front',base64:bytes.toString('base64')}]};
 const customer=((await customers.mutate(f.identity,body,key,randomUUID())) as {data:Row}).data;
 const p=await f.create(),write=async(b:unknown)=>((await f.rental.mutate(f.identity,b,randomUUID(),randomUUID())) as {data:Row}).data;
 const room=await write({action:'create-room',propertyId:p.id,code:'RETAINED'}),terms=await write({action:'create-agreement',roomId:room.id,tenantId:customer.id,startDate:'2026-11-01',monthlyRent:'2000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit synthetic terms'});
 const due=await write({action:'issue-due',agreementId:terms.id,period:'2026-11',dueDate:'2026-11-01',amount:'2000'}),account=await f.account({openingDate:'2026-11-01'});
 await write({action:'record-collection',agreementId:terms.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-02',allocations:[{dueId:due.id,amount:'1200'}],receivingAccountId:account.id,accountConfirmed:true});
 await new ExpenseService(f.properties).mutate(f.identity,{action:'record-expense',propertyId:p.id,category:'maintenance',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic retained vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}},randomUUID(),randomUUID());
 const docId=(await customers.profile(f.identity,customer.id,query)).kyc.documents[0].id;
 await engine.close();engine=new PGlite(f.dataDir);await engine.waitReady;
 const properties=new PropertyService(adapter(engine),f.identity),reopened=new CustomerService(properties),profile=await reopened.profile(f.identity,customer.id,query);
 assert.equal((profile.customer as Row).id,customer.id);assert.equal(profile.customer.balances[0].outstandingMinor,'80000');assert.equal(profile.kyc.status,'pending-review');assert.deepEqual((await reopened.getDocument(f.identity,docId)).content,bytes);
 assert.equal((await reopened.mutate(f.identity,body,key,randomUUID())).replay,true);
 assert.equal(Number((await new CompanyFinanceService(properties).overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),1000);
 assert.equal((await engine.query('SELECT * FROM hamdee_private.property_expenses')).rows.length,1);
 await engine.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.users.admin.id]);
 await assert.rejects(reopened.getDocument(f.identity,docId));
});
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());
 for(const file of ['007_local_car_rentals.up.sql','013_local_customers_kyc_cheques.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const customers=new CustomerService(f.properties);
 const write=async(body:unknown,key=randomUUID())=>await customers.mutate(f.identity,body,key,randomUUID()) as {data:Row;replay:boolean};
 return {...f,customers,write};
}

test('independent QA: atomic customer with private file stays pending, masks synthetic identifier and denies nonowner',async t=>{
 const f=await setup(t),bytes=Buffer.from('%PDF-1.4\n% synthetic empty identity placeholder\n%%EOF');
 const created=await f.write({action:'create-customer',name:'Synthetic QA contact',kyc:{identityName:'Synthetic QA contact',documentType:'Other',documentNumber:'SYNTHETIC-ONLY',expiryDate:'2027-11-30'},documents:[{name:'Synthetic.pdf',mimeType:'application/pdf',side:'front',base64:bytes.toString('base64')}]});
 const customerId=created.data.id,profile=await f.customers.profile(f.identity,customerId,query);
 assert.equal(profile.kyc.status,'pending-review');assert.equal((profile.kyc as Row).reviewedBy,null);assert.equal(profile.kyc.documents.length,1);
 assert.doesNotMatch(JSON.stringify(profile),/SYNTHETIC-ONLY|base64|synthetic empty identity placeholder/);
 const list=await f.customers.overview(f.identity,query);assert.equal(list.customers[0].kycStatus,'pending-review');assert.doesNotMatch(JSON.stringify(list),/SYNTHETIC-ONLY|contentSha/);
 const docId=profile.kyc.documents[0].id,file=await f.customers.getDocument(f.identity,docId);assert.deepEqual(file.content,bytes);
 await assert.rejects(f.customers.getDocument({issuer,subject:f.users.reader.subject},docId));
 await assert.rejects(f.customers.profile({issuer,subject:f.users.finance.subject},customerId,query));
 const before=(await f.pg.query('SELECT * FROM hamdee_private.tenants')).rows.length;
 await assert.rejects(f.write({action:'create-customer',name:'Synthetic failed file',documents:[{name:'bad.png',mimeType:'image/png',base64:bytes.toString('base64')}]}));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.tenants')).rows.length,before);
 const reveal=await f.write({action:'reveal-identity',customerId});assert.equal(reveal.data.documentNumber,'SYNTHETIC-ONLY');
 const commands=(await f.pg.query('SELECT result::text FROM hamdee_private.customer_commands')).rows;assert.doesNotMatch(JSON.stringify(commands),/SYNTHETIC-ONLY/);
});

test('independent QA: missing and expired KYC remain distinct and equal names are flagged without merge',async t=>{
 const f=await setup(t);
 const missing=await f.write({action:'create-customer',name:'Synthetic duplicate'});
 const expired=await f.write({action:'create-customer',name:'Synthetic duplicate',kyc:{identityName:'Synthetic duplicate',documentNumber:'SYNTHETIC-ONLY',expiryDate:'2020-01-01'}});
 assert.notEqual(missing.data.id,expired.data.id);
 const list=await f.customers.overview(f.identity,query);assert.equal(list.customers.length,2);assert.ok(list.customers.every(c=>c.potentialDuplicate));
 assert.equal((await f.customers.profile(f.identity,missing.data.id,query)).kyc.status,'not-added');
 assert.equal((await f.customers.profile(f.identity,expired.data.id,query)).kyc.status,'expired');
 await assert.rejects(f.write({action:'review-kyc',customerId:expired.data.id,expectedVersion:1,status:'verified',reason:'Synthetic QA expired review'}));
});

test('independent QA: held cheque is not cash; explicit clearance posts one bank deposit and retry never duplicates',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic cheque QA customer'})).data;
 const bank=await f.account({kind:'bank',openingDate:'2026-11-01'});
 const cheque=(await f.write({action:'record-security-cheque',customerId:customer.id,chequeNumber:'SYNTHETIC-QA-CHEQUE',bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-02',amount:'2000',currency:'XTS'})).data;
 const balance=async()=>Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance);
 assert.equal(await balance(),0);
 let profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.customer.balances[0].securityChequeMinor,'200000');assert.equal(profile.customer.balances[0].depositMinor,'0');assert.equal(profile.customer.balances[0].outstandingMinor,'0');
 await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-03',reason:'Synthetic owner presentation'});assert.equal(await balance(),0);
 const key=randomUUID(),command={action:'transition-cheque',chequeId:cheque.id,expectedVersion:2,status:'cleared',businessDate:'2026-11-04',reason:'Synthetic owner confirmed clearance',accountId:bank.id};
 const results=await Promise.all([f.write(command,key),f.write(command,key)]);assert.equal(results.filter(r=>r.replay).length,1);assert.equal(await balance(),2000);
 await assert.rejects(f.write(command));assert.equal(await balance(),2000);
 profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.customer.balances[0].securityChequeMinor,'0');assert.equal(profile.customer.balances[0].depositMinor,'200000');
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_collections')).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_money WHERE classification='security-deposit'")).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_receipts WHERE classification='security-deposit'")).rows.length,1);
 const posting=(await f.pg.query<{id:string}>("SELECT id FROM hamdee_private.ops_money WHERE classification='security-deposit'")).rows[0];
 await assert.rejects(f.writeFinance({action:'reverse',entryId:posting.id,reversedOn:'2026-11-06',reason:'Synthetic generic reversal must use cheque correction'}));
 assert.equal(await balance(),2000);
});

test('independent QA: uncleared return, cancellation, bounce and replacement preserve history without refunds',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic cheque transitions QA'})).data;
 const make=async(number:string,replacesId?:unknown)=>(await f.write({action:'record-security-cheque',customerId:customer.id,chequeNumber:number,bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-05',amount:'2000',currency:'XTS',...(replacesId?{replacesId}:{})})).data;
 for(const status of ['returned','cancelled','bounced']){
  const cheque=await make('SYNTHETIC-'+status);
  let version=1;
  if(status==='bounced'){await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-06',reason:'Synthetic present'});version=2;}
  await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:version,status,businessDate:'2026-11-07',reason:'Synthetic '+status});
  await assert.rejects(f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:version+1,status:'cleared',businessDate:'2026-11-08',reason:'Synthetic invalid reuse'}));
 }
 const original=await make('SYNTHETIC-original'),replacement=await make('SYNTHETIC-replacement',original.id);
 const profile=await f.customers.profile(f.identity,customer.id,query);
 assert.equal(profile.cheques.find(c=>c.id===original.id)?.status,'replaced');assert.equal(profile.cheques.find(c=>c.id===replacement.id)?.replacesId,original.id);
 assert.equal(profile.cheques.length,5);assert.equal(profile.customer.balances[0].securityChequeMinor,'200000');assert.equal(profile.customer.balances[0].depositMinor,'0');
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_receipts')).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_money WHERE entry_kind<>'opening'")).rows.length,0);
 assert.ok((await f.pg.query('SELECT * FROM hamdee_private.security_cheque_events')).rows.length>5);
});

test('independent QA: property cheque clearance and explicit bounce correction reconcile original rent and bank histories',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic linked cheque QA'})).data,p=await f.create(),bank=await f.account({kind:'bank',openingDate:'2026-11-01'});
 const rental=async(body:unknown)=>(await f.rental.mutate(f.identity,body,randomUUID(),randomUUID()) as {data:Row}).data;
 const room=await rental({action:'create-room',propertyId:p.id,code:'SYN-QA-CHEQUE',label:'Synthetic room'});
 const agreement=await rental({action:'create-agreement',roomId:room.id,tenantId:customer.id,startDate:'2026-11-01',monthlyRent:'2000',currency:'XTS',depositRequired:'0',dueTerms:'Synthetic confirmed terms'});
 await rental({action:'issue-due',agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-02',amount:'2000'});
 const cheque=(await f.write({action:'record-security-cheque',customerId:customer.id,agreementId:agreement.id,chequeNumber:'SYNTHETIC-LINKED',bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-02',amount:'2000',currency:'XTS'})).data;
 await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-03',reason:'Synthetic present'});
 await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:2,status:'cleared',businessDate:'2026-11-04',reason:'Synthetic clear',accountId:bank.id});
 let profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.customer.balances[0].depositMinor,'200000');assert.equal(profile.customer.balances[0].outstandingMinor,'200000');assert.equal(profile.collections.length,1);assert.equal(profile.collections[0].kind,'deposit');
 const key=randomUUID(),reverse={action:'reverse-cleared-cheque',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-05',reason:'Synthetic bank confirmed bounce correction'};
 await f.write(reverse,key);assert.equal((await f.write(reverse,key)).replay,true);
 profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.customer.balances[0].depositMinor,'0');assert.equal(profile.customer.balances[0].outstandingMinor,'200000');assert.equal(profile.cheques[0].status,'bounced');
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),0);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_money WHERE entry_kind='reversal'")).rows.length,1);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.security_cheque_events')).rows.length,4);
 const originalDeposit=profile.collections.find(c=>c.kind==='deposit');assert.ok(originalDeposit);
 await assert.rejects(f.writeFinance({action:'receive',accountId:bank.id,sourceKind:'property-rent',sourceId:originalDeposit.id,ownerConfirmedDisposition:true}));
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),0);
});

test('independent QA: short identity identifiers stay masked until explicit reveal',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic short ID QA',kyc:{documentNumber:'QA'}})).data;
 const profile=await f.customers.profile(f.identity,customer.id,query);
 assert.doesNotMatch(String((profile.kyc as Row).maskedDocumentNumber),/QA/);
 const reveal=await f.write({action:'reveal-identity',customerId:customer.id});assert.equal(reveal.data.documentNumber,'QA');
});

test('independent QA: unlinked funded deposit refunds once, prevents excess and blocks a reversal after refund',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic refundable cheque QA'})).data,bank=await f.account({kind:'bank',openingDate:'2026-11-01'});
 const cheque=(await f.write({action:'record-security-cheque',customerId:customer.id,chequeNumber:'SYNTHETIC-REFUND',bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-02',amount:'2000',currency:'XTS'})).data;
 await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-03',reason:'Synthetic present'});
 await f.write({action:'transition-cheque',chequeId:cheque.id,expectedVersion:2,status:'cleared',businessDate:'2026-11-04',reason:'Synthetic clear',accountId:bank.id});
 const key=randomUUID(),refund={action:'refund-security-deposit',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-06',amount:'500',accountId:bank.id,reason:'Synthetic actual refund'};
 await f.write(refund,key);assert.equal((await f.write(refund,key)).replay,true);
 const profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.customer.balances[0].depositMinor,'150000');
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),1500);
 await assert.rejects(f.write({...refund,amount:'1501'}));
 await assert.rejects(f.write({action:'reverse-cleared-cheque',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-07',reason:'Synthetic denied post-refund reversal'}));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.security_deposit_refunds')).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM hamdee_private.ops_money WHERE entry_kind='reversal'")).rows.length,0);
 const before=await f.customers.profile(f.identity,customer.id,{asOf:'2026-11-05'});assert.equal(before.customer.balances[0].depositMinor,'200000');
});

test('independent QA: explicit car link reuses tenant ID, preserves native precision and forbids relinking',async t=>{
 const f=await setup(t),customer=(await f.write({action:'create-customer',name:'Synthetic unified QA customer'})).data,other=(await f.write({action:'create-customer',name:'Synthetic distinct QA customer'})).data,cars=new CarRentalService(f.properties);
 const car=async(body:unknown)=>(await cars.mutate(f.identity,body,randomUUID(),randomUUID())).data as unknown as Row;
 const vehicle=await car({action:'create-vehicle',registration:'SYNTHETIC-UNIFIED',make:'Synthetic',model:'Synthetic exact car',status:'active'});
 const agreement=await car({action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic source snapshot',customerContact:'synthetic@example.invalid',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'1000.123456',currency:'XTS',billingPeriod:'Synthetic explicit November term'});
 await car({action:'record-collection',agreementId:agreement.id,receiptKey:randomUUID(),receivedDate:'2026-11-04',amount:'100.000001',currency:'XTS',method:'cash'});
 await car({action:'record-expense',vehicleId:vehicle.id,agreementId:agreement.id,expenseKey:randomUUID(),expenseDate:'2026-11-05',amount:'10.123',currency:'XTS',description:'Synthetic customer-attributable cost'});
 await f.write({action:'link-car',customerId:customer.id,agreementId:agreement.id,reason:'Synthetic owner reviewed link'});
 await assert.rejects(f.write({action:'link-car',customerId:other.id,agreementId:agreement.id,reason:'Synthetic conflicting link'}));
 const list=await f.customers.overview(f.identity,{...query,q:'SYNTHETIC-UNIFIED'});assert.equal(list.customers.length,1);assert.equal((list.customers[0] as Row).id,customer.id);assert.equal(list.customers[0].customerType,'car');
 const profile=await f.customers.profile(f.identity,customer.id,query);assert.equal(profile.carRentals.length,1);assert.equal((profile.carRentals[0] as Row).id,agreement.id);assert.equal(profile.carRentals[0].collections[0].amount,'100.000001');assert.equal(profile.carRentals[0].expenses[0].amount,'10.123');assert.equal(profile.customer.balances[0].carOutstandingAmount,'900.123455');
 assert.deepEqual(profile.carStatementBalances,[{currency:'XTS',openingAmount:'0',closingAmount:'900.123455'}]);
 assert.deepEqual(profile.history.filter(event=>String(event.action).startsWith('cars:')).map(event=>event.action).sort(),['cars:create-agreement','cars:record-collection','cars:record-expense']);
 const filtered=await f.customers.profile(f.identity,customer.id,{asOf:'2026-11-30',from:'2026-11-03',currency:'XTS'});assert.equal(filtered.carStatement.length,1);assert.deepEqual(filtered.carStatementBalances,[{currency:'XTS',openingAmount:'1000.123456',closingAmount:'900.123455'}]);
 const earlier=await f.customers.profile(f.identity,customer.id,{asOf:'2026-11-03'});assert.equal(earlier.carRentals[0].collections.length,0);assert.deepEqual(earlier.carStatementBalances,[{currency:'XTS',openingAmount:'0',closingAmount:'1000.123456'}]);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.tenants')).rows.length,2);
});
