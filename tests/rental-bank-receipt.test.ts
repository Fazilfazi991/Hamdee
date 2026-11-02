import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture} from './support/owner-crm-harness';

test('bank collection and account placement are atomic, scoped and replay-safe',async t=>{
 const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql','011_local_owner_occupancy.up.sql']});t.after(()=>f.close());await f.login();
 const post=async(path:string,body:unknown,key=randomUUID())=>f.request('POST','/api/hamdee/v1/'+path,body,{'Idempotency-Key':key});
 const saved=async(path:string,body:unknown,status=200)=>{const r=await post(path,body),b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b.data;};
 const property=await saved('properties',{name:'Synthetic bank test villa'},201);
 const room=await saved('rental',{action:'create-room',propertyId:property.id,code:'SYN-1'});
 const tenant=await saved('rental',{action:'create-tenant',name:'Synthetic bank tenant'});
 await saved('rental',{action:'confirm-occupancy',roomId:room.id,tenantId:tenant.id,status:'occupied',effectiveDate:'2026-11-01',expectedOccupancyVersion:0,terms:{monthlyRent:'1000',currency:'QAR',dueTerms:'day 5'}});
 const scope={roomId:room.id,tenantId:tenant.id,period:'2026-11'};
 const due=await saved('rental',{action:'issue-due',...scope,dueDate:'2026-11-05',amount:'1000'});
 const bank=await saved('company-finance/commands',{action:'create-account',name:'Synthetic bank',scope:'company',kind:'bank',currency:'QAR',openingDate:'2026-11-01',openingAmount:'0',ownerConfirmedOpening:true});
 const personal=await saved('personal-finance/commands',{action:'create-account',name:'Synthetic personal',scope:'personal',kind:'bank',currency:'QAR',openingDate:'2026-11-01',openingAmount:'0',ownerConfirmedOpening:true});
 const receipt={action:'record-collection',...scope,kind:'rent',method:'bank',amount:'250',receivedDate:'2026-11-06',allocations:[{dueId:due.id,amount:'250'}],receivingAccountId:bank.id,accountConfirmed:true};
 const key=randomUUID(),first=await post('rental',receipt,key);assert.equal(first.status,200);const firstData=await first.json();
 const retry=await post('rental',receipt,key);assert.equal(retry.status,200);assert.equal((await retry.json()).replay,true);
 const invalid=await post('rental',{...receipt,receivingAccountId:personal.id});assert.equal(invalid.status,409);
 const pending=await post('rental',{...receipt,kind:'advance',method:'cheque',allocations:[]});assert.equal(pending.status,409);
 const beforeOpening=await post('rental',{...receipt,receivedDate:'2026-10-30'});assert.equal(beforeOpening.status,409);
 const finance=await f.request('GET','/api/hamdee/v1/company-finance?month=2026-11&asOf=2026-11-30'),overview=(await finance.json()).data;
 assert.equal(overview.totals[0].receipts,'250');assert.equal(overview.totals[0].balance,'250');
 const rental=await f.request('GET','/api/hamdee/v1/rental?month=2026-11&asOf=2026-11-30'),state=(await rental.json()).data;
 assert.equal(state.collections.length,1);assert.equal(state.dues[0].outstandingMinor,'75000');
 const duplicate=await post('company-finance/commands',{action:'receive',accountId:bank.id,sourceKind:'property-rent',sourceId:firstData.data.id,ownerConfirmedDisposition:true});assert.equal(duplicate.status,409);
});
