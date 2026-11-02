import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {LocalPostgresDatabase,type Database,type Sql} from '../../src/database';
import {PropertyService} from '../../src/service';
import {RentalService} from '../../src/rental';
import {ExpenseService} from '../../src/expenses';
import {CustomerService} from '../../src/customers';
import {DocumentService} from '../../src/documents';
import {CompanyFinanceService} from '../../src/company-finance';
import {StaffCollectionsService} from '../../src/staff-collections';
import {CarRentalService} from '../../src/car-rentals';
import {FinancialCorrectionService} from '../../src/financial-corrections';
import {ReconciliationService} from '../../src/reconciliation';
import {PrincipalService} from '../../src/principal';
import {SourceReportService} from '../../src/source-reports';
import {SupportingRecordService} from '../../src/supporting-records';
import {up} from '../support/fixture';
import {inspectOwnerPortableRuntime,startOwnerNativeCluster,ownerNativeConnection,ownerQaInputs,seedOwnerAppRecords,startOwnerAppProcess,OwnerCookieJar} from '../support/owner-crm-harness';

type Row=Record<string,unknown>;
type CommandService={mutate(identity:{issuer:string;subject:string},body:unknown,key:string,requestId:string):Promise<unknown>};
const input=ownerQaInputs(),identity={issuer:input.issuer,subject:input.ownerSubject};
const evidence:Row={environment:'owned loopback native PostgreSQL 17.11; synthetic records and injected owner provider only',priorCarSourceCommit:'75dd2a21c17d9e4846cbb3ce59d1e056029a9a64'};
const witness:Row={};
let cluster:Awaited<ReturnType<typeof startOwnerNativeCluster>>|undefined,pool:Pool,a:LocalPostgresDatabase,b:LocalPostgresDatabase,backendConnection:string;
let left:PropertyService,right:PropertyService;
let gate:ReturnType<typeof rendezvous>|undefined;
function rendezvous(){const pids=new Set<number>();let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});return {pids,async enter(sql:Sql){pids.add((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid);if(pids.size===2)release();let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([ready,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Independent native sessions did not rendezvous')),15000);})]);}finally{clearTimeout(timer);}}};}
function observed(db:Database):Database{return {transaction:work=>db.transaction(sql=>work({query:async<T>(text:string,params?:unknown[])=>{if(gate&&text.includes('pg_advisory_xact_lock')&&params?.[0]==='hamdee-operations-money')await gate.enter(sql);return sql.query<T>(text,params);}}))};}
function connect(){assert.ok(cluster);pool=new Pool(ownerNativeConnection(cluster.connection,'disposable-local-hamdee-owner'));a=new LocalPostgresDatabase(backendConnection,()=>{});b=new LocalPostgresDatabase(backendConnection,()=>{});left=new PropertyService(observed(a),identity);right=new PropertyService(observed(b),identity);}
async function disconnect(){await Promise.all([pool?.end(),a?.close(),b?.close()]);}
async function command(service:CommandService,body:Row,key=randomUUID()){const result=await service.mutate(identity,body,key,randomUUID()) as {data:Row;replay:boolean};assert.ok(result.data);return result;}
const rental=(body:Row)=>command(new RentalService(left),body).then(r=>r.data);
const finance=(body:Row)=>command(new CompanyFinanceService(left),body).then(r=>r.data);
const customer=(body:Row)=>command(new CustomerService(left),body).then(r=>r.data);
const staff=(body:Row)=>command(new StaffCollectionsService(left),body).then(r=>r.data);
async function snapshot(tables:string[]){const result:Row={};for(const table of tables)result[table]=(await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM hamdee_private.${table} t`)).rows[0].rows;return result;}
async function exactBalance(accountId:unknown,asOf='2026-11-30'){return (await pool.query<{balance:string}>('SELECT trim_scale(coalesce(sum(delta),0))::text AS balance FROM hamdee_private.ops_money WHERE account_id=$1 AND business_date<=$2::date',[accountId,asOf])).rows[0].balance;}
function exact(value:unknown,expected:string){const scale=(x:unknown)=>{const match=String(x).match(/^(-?)(\d+)(?:\.(\d{1,12}))?$/);assert.ok(match);return (match[1]?-1n:1n)*(BigInt(match[2])*1000000000000n+BigInt((match[3]??'').padEnd(12,'0')));};assert.equal(scale(value),scale(expected));}
async function race<T>(one:()=>Promise<T>,two:()=>Promise<T>){const current=rendezvous();gate=current;try{const results=await Promise.allSettled([one(),two()]);assert.equal(current.pids.size,2);return {results,pids:[...current.pids]};}finally{gate=undefined;}}

before(async()=>{
 const tools=path.resolve(process.env.HAMDEE_NATIVE_RUNTIME_ROOT||'.test-tools'),runtime=await inspectOwnerPortableRuntime(path.join(tools,'postgresql-17.11-5-windows-x64-binaries.zip'),path.join(tools,'postgresql-17.11-5'));
 cluster=await startOwnerNativeCluster(runtime);const initial=new Pool(ownerNativeConnection(cluster.connection,'disposable-local-hamdee-owner'));
 try{
  await initial.query(await up(['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql','009_local_partner_corrections.up.sql','011_local_owner_occupancy.up.sql','012_local_private_documents.up.sql']));
  const prior=await readFile(new URL('../support/legacy-car-source-013.sql',import.meta.url),'utf8');evidence.priorCarMigrationSha256=createHash('sha256').update(prior.replace(/\r\n/g,'\n')).digest('hex');assert.equal(evidence.priorCarMigrationSha256,'c005ae49ecd4294599ba0545855d048e7c9a489d00f4fa1694da66b786aba12a');await initial.query(prior);
  witness.owner=(await seedOwnerAppRecords(initial)).id;
  const password=randomBytes(32).toString('hex');await initial.query(`CREATE ROLE hamdee_continuation_backend LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);await initial.query('GRANT hamdee_runtime TO hamdee_continuation_backend');const url=new URL(cluster.connection);url.username='hamdee_continuation_backend';url.password=password;backendConnection=url.toString();
 }finally{await initial.end();}
 connect();
 const p=await left.mutate(identity,{action:'create',key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic native preserved villa'}});witness.property=p.data.id;
 const room=await rental({action:'create-room',propertyId:witness.property,code:'NATIVE-01',label:'Synthetic preserved room'}),tenant=await rental({action:'create-tenant',name:'Synthetic native retained customer',phone:'TEST-ONLY'});witness.room=room.id;witness.customer=tenant.id;
 const confirmed=await rental({action:'confirm-occupancy',roomId:room.id,tenantId:tenant.id,status:'occupied',effectiveDate:'2026-11-01',expectedOccupancyVersion:0,notes:'Synthetic confirmed occupancy',terms:{monthlyRent:'2000',currency:'XTS',depositRequired:'1000',dueTerms:'Explicit synthetic due day'}});witness.agreement=confirmed.internalAgreementId;
 witness.due=(await rental({action:'issue-due',agreementId:witness.agreement,period:'2026-11',dueDate:'2026-11-01',amount:'2000'})).id;
 const car=await command(new CarRentalService(left),{action:'create-vehicle',model:'Synthetic native source car',status:'needs_confirmation',sourceKey:'native-source-reference-only',sourceReference:'Synthetic prior cell reference; no financial posting'});witness.vehicle=car.data.id;
 const pdf=Buffer.from('%PDF-1.4\n% synthetic native optional property document\n%%EOF');witness.roomDocument=(await new DocumentService(left).upload(identity,{propertyId:witness.property,roomId:witness.room,name:'Synthetic room.pdf',mimeType:'application/pdf',base64:pdf.toString('base64')},randomUUID())).data.id;
 const originalTables=['properties','property_revisions','tenants','rooms','rental_agreements','rent_dues','room_occupancy_confirmations','property_documents','car_vehicles','car_vehicle_revisions','car_source_references','app_users','role_assignments'];const original=await snapshot(originalTables);
 for(const file of ['013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','015_local_account_reconciliation.up.sql','016_local_scoped_expenses.up.sql'])await pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.deepEqual(await snapshot(originalTables),original);
 witness.cash=(await finance({action:'create-account',scope:'company',kind:'cash',name:'Synthetic native cash',currency:'XTS',openingDate:'2026-11-01',openingAmount:'10000',ownerConfirmedOpening:true})).id;
 witness.bank=(await finance({action:'create-account',scope:'company',kind:'bank',name:'Synthetic native bank',currency:'XTS',openingDate:'2026-11-01',openingAmount:'10000',ownerConfirmedOpening:true})).id;
 const bill=await command(new ExpenseService(left),{action:'record-expense',propertyId:witness.property,category:'maintenance',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic native retained vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:witness.cash}});witness.bill=bill.data.id;witness.payment=(await pool.query('SELECT id FROM hamdee_private.expense_payments WHERE expense_id=$1',[witness.bill])).rows[0].id;
 witness.deposit=(await rental({action:'record-collection',agreementId:witness.agreement,kind:'deposit',method:'cash',amount:'1000',receivedDate:'2026-11-02',receivingAccountId:witness.cash,accountConfirmed:true})).id;witness.rentalRefund=(await rental({action:'refund-deposit',agreementId:witness.agreement,method:'cash',amount:'300',receivedDate:'2026-11-03',fundingAccountId:witness.cash})).id;
 const privatePdf=Buffer.from('%PDF-1.4\n% synthetic native private identity placeholder\n%%EOF');witness.privateBytes=privatePdf.toString('hex');witness.privateDocument=(await customer({action:'upload-kyc',customerId:witness.customer,name:'Synthetic private.pdf',mimeType:'application/pdf',base64:privatePdf.toString('base64'),side:'front'})).id;
 const cheque=await customer({action:'record-security-cheque',customerId:witness.customer,chequeNumber:'SYN-NATIVE-SECURITY',bank:'Synthetic drawer bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-01',amount:'1000',currency:'XTS'});witness.cheque=cheque.id;
 await customer({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-02',reason:'Synthetic presentation'});await customer({action:'transition-cheque',chequeId:cheque.id,expectedVersion:2,status:'cleared',businessDate:'2026-11-03',accountId:witness.bank,reason:'Synthetic confirmed clearance'});
 witness.securityRefund=(await customer({action:'refund-security-deposit',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-04',amount:'300',accountId:witness.bank,reason:'Synthetic retained refund'})).id;
 const preservedTables=[...originalTables,'ops_money','ops_events','ops_commands','property_expenses','expense_payments','rent_collections','customer_documents','security_cheques','security_cheque_events','security_deposit_refunds'],preserved=await snapshot(preservedTables);
 const roleSnapshot=async()=>({roles:(await pool.query("SELECT rolname,rolcanlogin,rolsuper,rolinherit,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname LIKE 'hamdee%' ORDER BY rolname")).rows,memberships:(await pool.query('SELECT roleid::regrole::text AS role,member::regrole::text AS member,admin_option FROM pg_auth_members ORDER BY role,member')).rows});const roles=await roleSnapshot();
 const upgrade=await pool.connect();try{await upgrade.query('BEGIN');for(const file of ['017_local_corrections_and_source_compatibility.up.sql','018_local_collector_counts.up.sql','019_local_principal_supporting_records.up.sql'])await upgrade.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await upgrade.query('COMMIT');}catch(error){await upgrade.query('ROLLBACK');throw error;}finally{upgrade.release();}
 assert.deepEqual(await snapshot(preservedTables),preserved);assert.deepEqual(await roleSnapshot(),roles);
 evidence.upgrade={preservedTables:preservedTables.length,originalCustomerIds:true,prior013CarReferences:true,occupancy:true,privateRoomDocuments:true,privateKyc:true,historicalFinancialRows:true,roleAttributesAndMembershipsUnchanged:true};
},{timeout:120000});

after(async()=>{gate=undefined;try{await disconnect();}finally{await cluster?.close();evidence.engine=cluster?.evidence();await mkdir('evidence/continuation-native',{recursive:true});await writeFile('evidence/continuation-native/integrated-evidence.json',JSON.stringify(evidence,null,2));}});

test('Native continuation: populated prior013 car-source schema upgrades without losing occupancy, documents, identities, funds or permissions',async()=>{
 const status=(await pool.query('SELECT registration,make,status FROM hamdee_private.car_vehicles WHERE id=$1',[witness.vehicle])).rows[0];assert.deepEqual(status,{registration:null,make:null,status:'needs_confirmation'});
 assert.equal((await pool.query('SELECT * FROM hamdee_private.car_source_references WHERE vehicle_id=$1',[witness.vehicle])).rowCount,1);
 assert.equal((await new CustomerService(left).profile(identity,witness.customer,{asOf:'2026-11-30'})).kyc.status,'pending-review');
 const permissions=await a.transaction(sql=>sql.query<{rolsuper:boolean;rolbypassrls:boolean}>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user'));assert.deepEqual(permissions.rows[0],{rolsuper:false,rolbypassrls:false});
 await assert.rejects(a.transaction(sql=>sql.query('SELECT * FROM hamdee_private.customer_documents')),/permission denied/);
 await assert.rejects(left.ownerContext(identity,sql=>sql.query('DELETE FROM hamdee_private.tenants')),/permission denied/);
 const dates=await a.transaction(sql=>sql.query<{calendar:string}>("SELECT DATE '2026-11-02' AS calendar"));assert.equal(dates.rows[0].calendar,'2026-11-02');
 const receipt=(await new RentalService(left).overview(identity,{month:'2026-11',asOf:'2026-11-30'})).collections.find(row=>(row as Row).id===witness.deposit) as Row;assert.equal(receipt.receivedDate,'2026-11-02');
 const movement=(await pool.query<{business_date:string}>("SELECT m.business_date::text FROM hamdee_private.ops_money m JOIN hamdee_private.ops_claims c ON c.id=m.claim_id WHERE c.source_kind='property-rent' AND c.source_id=$1",[witness.deposit])).rows[0];assert.equal(movement.business_date,'2026-11-02');evidence.calendarDates={nodeTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,receivedDate:receipt.receivedDate,moneyDate:movement.business_date,dateParserReturnsCalendarString:true,noTimeZoneOverride:true};
});

test('Native continuation: two physical sessions correct a funded bill exactly once, retain cutoffs and deny standalone reversal',async()=>{
 const body={action:'correct-expense-payment',paymentId:witness.payment,correctedOn:'2026-11-05',reason:'Synthetic source correction',replacement:{amount:'150',method:'cash',fundingAccountId:witness.cash}},key=randomUUID(),before=await exactBalance(witness.cash);
 const run=await race(()=>command(new FinancialCorrectionService(left),body,key),()=>command(new FinancialCorrectionService(right),body,key));assert.ok(run.results.every(result=>result.status==='fulfilled'));const results=run.results.map(result=>{assert.equal(result.status,'fulfilled');return result.value;});assert.deepEqual(results.map(result=>result.replay).sort(),[false,true]);assert.equal(results[0].data.id,results[1].data.id);
 const costs=new ExpenseService(left),earlier=await costs.overview(identity,{month:'2026-11',asOf:'2026-11-04'}),later=await costs.overview(identity,{month:'2026-11',asOf:'2026-11-30'});
 assert.equal((earlier.expenses.find(row=>(row as Row).id===witness.bill) as Row).paidMinor,'20000');assert.equal((later.expenses.find(row=>(row as Row).id===witness.bill) as Row).paidMinor,'15000');assert.equal((later.expenses.find(row=>(row as Row).id===witness.bill) as Row).outstandingMinor,'45000');
 exact((await pool.query<{amount:string}>('SELECT ($1::numeric-$2::numeric)::text AS amount',[await exactBalance(witness.cash),before])).rows[0].amount,'50');
 const replacement=(await pool.query('SELECT l.entry_id FROM hamdee_private.expense_funding_links l WHERE payment_id=$1',[results[0].data.replacementId])).rows[0];await assert.rejects(finance({action:'reverse',entryId:replacement.entry_id,reversedOn:'2026-11-06',reason:'Synthetic unsafe isolated reversal'}));
 await assert.rejects(command(new FinancialCorrectionService(left),{...body,reason:'Synthetic changed payload'},key),{code:'IDEMPOTENCY_KEY_REUSED'});evidence.billCorrection={pids:run.pids,oneCorrection:true,oneReplay:true,earlierPaid:'200',laterPaid:'150',remaining:'450',standaloneReversalDenied:true};
});

test('Native continuation: late audit failure rolls back compensation, replacement and source effects, then original key safely retries',async()=>{
 const bill=(await command(new ExpenseService(left),{action:'record-expense',propertyId:witness.property,category:'cleaning',expenseDate:'2026-11-03',amount:'600',currency:'XTS',vendorName:'Synthetic fault vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-03',fundingAccountId:witness.cash}})).data;
 const payment=(await pool.query('SELECT id FROM hamdee_private.expense_payments WHERE expense_id=$1',[bill.id])).rows[0].id,body={action:'correct-expense-payment',paymentId:payment,correctedOn:'2026-11-06',reason:'Synthetic rollback correction',replacement:{amount:'100',method:'cash',fundingAccountId:witness.cash}},key=randomUUID();
 const tables=['financial_corrections','expense_payments','expense_funding_links','ops_money','ops_events','ops_commands'],before=await snapshot(tables);
 await pool.query("CREATE FUNCTION hamdee_private.qa_continuation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'financial-correction:%' THEN RAISE EXCEPTION 'synthetic late audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER qa_continuation_fail BEFORE INSERT ON hamdee_private.ops_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.qa_continuation_fail();");
 try{await assert.rejects(command(new FinancialCorrectionService(left),body,key),/synthetic late audit failure/);}finally{await pool.query('DROP TRIGGER qa_continuation_fail ON hamdee_private.ops_events;DROP FUNCTION hamdee_private.qa_continuation_fail();');}
 assert.deepEqual(await snapshot(tables),before);await command(new FinancialCorrectionService(left),body,key);evidence.rollback={lateAudit:true,sourceAndMoneyUnchanged:true,sameKeyRetry:true};
});

test('Native continuation: rental and security refund source corrections preserve originals, deposits and bank/cash balances by date',async()=>{
 const correction=new FinancialCorrectionService(left);
 for(const [action,key] of [['correct-rental-refund','collectionId'],['correct-security-refund','refundId']] as const){const sourceId=action==='correct-rental-refund'?witness.rentalRefund:witness.securityRefund,account=action==='correct-rental-refund'?witness.cash:witness.bank;
  const body={action,[key]:sourceId,correctedOn:'2026-11-07',reason:'Synthetic funded refund correction',replacement:{amount:'200',method:account===witness.bank?'bank':'cash',fundingAccountId:account}},commandKey=randomUUID(),before=await exactBalance(account);
  await command(correction,body,commandKey);assert.equal((await command(correction,body,commandKey)).replay,true);exact((await pool.query<{amount:string}>('SELECT ($1::numeric-$2::numeric)::text AS amount',[await exactBalance(account),before])).rows[0].amount,'100');
 }
 const customerService=new CustomerService(left),earlier=await customerService.profile(identity,witness.customer,{asOf:'2026-11-06'}),later=await customerService.profile(identity,witness.customer,{asOf:'2026-11-30'});
 assert.equal(earlier.customer.balances[0].depositMinor,'140000');assert.equal(later.customer.balances[0].depositMinor,'160000');assert.equal(later.customer.balances[0].outstandingMinor,'200000');
 evidence.refundCorrections={earlierFundedDeposit:'1400',laterFundedDeposit:'1600',rentOutstanding:'2000',originalRowsRetained:true,retriesReplay:true};
});

test('Native continuation: collector opening and counts remain evidence only; backdated receipts retain original snapshot and pending cheques stay noncash',async()=>{
 const collector=await staff({action:'create-collector',name:'Synthetic native counted collector'}),reconciliation=new ReconciliationService(left);witness.collector=collector.id;
 await command(reconciliation,{action:'confirm-collector-opening',collectorId:collector.id,currency:'XTS',openingDate:'2026-11-01',openingAmount:'20',method:'cash',ownerConfirmedOpening:true,sourceReference:'Synthetic owner-confirmed opening'});
 await rental({action:'record-collection',agreementId:witness.agreement,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-11-02',allocations:[{dueId:witness.due,amount:'1200'}],receivingCollectorId:collector.id,accountConfirmed:true});
 await staff({action:'handover',collectorId:collector.id,accountId:witness.cash,amount:'1000',currency:'XTS',handedOn:'2026-11-03',reference:'SYN-NATIVE-HANDOVER'});
 const pending=await rental({action:'record-collection',agreementId:witness.agreement,kind:'deposit',method:'cheque',amount:'2000',receivedDate:'2026-11-03'});await staff({action:'record-collection',collectorId:collector.id,sourceKind:'property-rent',sourceId:pending.id});
 const before=(await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n,key=randomUUID(),body={action:'record-collector-reconciliation',collectorId:collector.id,currency:'XTS',reconciledOn:'2026-11-04',countedBalance:'200',explanation:'Synthetic counted amount awaiting explanation'};
 await command(reconciliation,body,key);assert.equal((await command(reconciliation,body,key)).replay,true);assert.equal((await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n,before);
 await rental({action:'record-collection',agreementId:witness.agreement,kind:'advance',method:'cash',amount:'100',receivedDate:'2026-11-02',receivingCollectorId:collector.id,accountConfirmed:true});
 const counted=(await reconciliation.overview(identity,{asOf:'2026-11-30',collectorId:String(collector.id),currency:'XTS'})).collectorRecords[0];exact(counted.calculatedBalance,'220');exact(counted.currentCalculatedBalance,'320');exact(counted.difference,'-20');
 const overview=await new StaffCollectionsService(left).overview(identity,{month:'2026-11',asOf:'2026-11-30'});exact(overview.totals[0].balance,'320');exact(overview.totals[0].pending,'2000');evidence.collector={confirmedOpening:'20',originalCalculated:'220',currentCalculated:'320',actualCount:'200',originalDifference:'-20',pendingCheques:'2000',countCreatesNoMoney:true};
});

test('Native continuation: car cash/bank receipts place exact funds once and reuse the canonical customer without converting pending cheques to money',async()=>{
 const cars=new CarRentalService(left),vehicle=(await command(cars,{action:'create-vehicle',registration:'SYN-NATIVE-CONNECTED',make:'Synthetic',model:'Synthetic native connected car',status:'active'})).data;
 const terms=(await command(cars,{action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic native retained customer',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'2000.123456',currency:'XTS',billingPeriod:'Explicit synthetic total'})).data;
 await customer({action:'link-car',customerId:witness.customer,agreementId:terms.id,reason:'Synthetic explicit canonical customer link'});
 const key=randomUUID(),body={action:'record-collection',agreementId:terms.id,receiptKey:randomUUID(),receivedDate:'2026-11-12',amount:'1200.123456',currency:'XTS',method:'bank',receivingAccountId:witness.bank,accountConfirmed:true},before=await exactBalance(witness.bank);
 const run=await race(()=>command(cars,body,key),()=>command(new CarRentalService(right),body,key));assert.ok(run.results.every(result=>result.status==='fulfilled'));const results=run.results.map(result=>{assert.equal(result.status,'fulfilled');return result.value;});assert.deepEqual(results.map(result=>result.replay).sort(),[false,true]);assert.equal(results[0].data.id,results[1].data.id);
 exact((await pool.query<{amount:string}>('SELECT ($1::numeric-$2::numeric)::text AS amount',[await exactBalance(witness.bank),before])).rows[0].amount,'1200.123456');
 await command(cars,{action:'record-collection',agreementId:terms.id,receiptKey:randomUUID(),receivedDate:'2026-11-12',amount:'400',currency:'XTS',method:'cash',receivingCollectorId:witness.collector,accountConfirmed:true});
 const count=(await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n;await command(cars,{action:'record-collection',agreementId:terms.id,receiptKey:randomUUID(),receivedDate:'2026-11-12',amount:'500',currency:'XTS',method:'cheque'});assert.equal((await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n,count);
 const date=(await pool.query<{business_date:string}>("SELECT m.business_date::text FROM hamdee_private.ops_money m JOIN hamdee_private.ops_claims c ON c.id=m.claim_id WHERE c.source_kind='car-rental' AND c.source_id=$1",[results[0].data.id])).rows[0].business_date;assert.equal(date,'2026-11-12');
 const profile=await new CustomerService(left).profile(identity,witness.customer,{asOf:'2026-11-30'});exact(profile.customer.balances[0].carOutstandingAmount,'400');assert.equal((profile.customer as Row).id,witness.customer);assert.equal(profile.carRentals.length,1);assert.equal((await pool.query('SELECT * FROM hamdee_private.car_receipts WHERE agreement_id=$1',[terms.id])).rowCount,3);
 evidence.carConnected={pids:run.pids,bankReceived:'1200.123456',collectorReceived:'400',pendingCheque:'500',remaining:'400',oneReplay:true,calendarMoneyDate:date,canonicalCustomerIdPreserved:true};
});

test('Native continuation: principal directions, exact repayment races and linked corrections never become rent income',async()=>{
 const principal=new PrincipalService(left),other=new PrincipalService(right),rentBefore=(await pool.query("SELECT count(*)::int AS n FROM hamdee_private.rent_collections WHERE kind='rent'")).rows[0].n;
 const receivable=(await command(principal,{action:'create-obligation',direction:'receivable',kind:'loan',counterparty:'Synthetic native debtor',customerId:witness.customer,amount:'1000.123456',currency:'XTS',openedOn:'2026-11-01'})).data;
 const payable=(await command(principal,{action:'create-obligation',direction:'payable',kind:'loan',counterparty:'Synthetic native creditor',amount:'500',currency:'XTS',openedOn:'2026-11-01'})).data;
 const key=randomUUID(),body={action:'repay',obligationId:receivable.id,amount:'100.000001',paidOn:'2026-11-08',method:'cash',accountId:witness.cash};const first=await race(()=>command(principal,body,key),()=>command(other,body,key));assert.ok(first.results.every(result=>result.status==='fulfilled'));const movement=first.results.map(result=>{assert.equal(result.status,'fulfilled');return result.value;});assert.deepEqual(movement.map(result=>result.replay).sort(),[false,true]);
 await command(principal,{action:'correct-repayment',movementId:movement[0].data.id,correctedOn:'2026-11-09',reason:'Synthetic precise repayment correction',replacement:{amount:'80.000001',paidOn:'2026-11-09',method:'cash',accountId:witness.cash}});
 await command(principal,{action:'repay',obligationId:payable.id,amount:'20',paidOn:'2026-11-09',method:'cash',accountId:witness.cash});
 const competing={action:'repay',obligationId:receivable.id,amount:'600',paidOn:'2026-11-10',method:'cash',accountId:witness.cash},second=await race(()=>command(principal,{...competing,reference:'SYN-PRINCIPAL-A'}),()=>command(other,{...competing,reference:'SYN-PRINCIPAL-B'}));assert.equal(second.results.filter(result=>result.status==='fulfilled').length,1);const failed=second.results.find(result=>result.status==='rejected');assert.ok(failed&&failed.status==='rejected');assert.equal(failed.reason.code,'PRINCIPAL_EXCEEDED');
 const current=await principal.overview(identity,{asOf:'2026-11-30'});const obligations=current.obligations as Row[];exact(obligations.find(row=>row.id===receivable.id)!.outstandingAmount,'320.123455');exact(obligations.find(row=>row.id===payable.id)!.outstandingAmount,'480');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM hamdee_private.rent_collections WHERE kind='rent'")).rows[0].n,rentBefore);evidence.principal={replayPids:first.pids,competingPids:second.pids,oneRepaymentWinner:true,receivableRemaining:'320.123455',payableRemaining:'480',rentRowsUnchanged:true};
});

test('Native continuation: principal late-failure rollback and raw restricted-role writes cannot separate repayments from their accounting evidence',async()=>{
 const principal=new PrincipalService(left),obligation=(await command(principal,{action:'create-obligation',direction:'receivable',kind:'reimbursement',counterparty:'Synthetic native rollback counterparty',amount:'1234.123456789123',currency:'XTS',openedOn:'2026-11-01'})).data,key=randomUUID(),body={action:'repay',obligationId:obligation.id,amount:'100.123456789123',paidOn:'2026-11-11',method:'cash',accountId:witness.cash};
 const tables=['principal_movements','principal_corrections','ops_receipts','ops_claims','ops_money','ops_events','ops_commands'],before=await snapshot(tables);
 await pool.query("CREATE FUNCTION hamdee_private.qa_principal_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'principal:%' THEN RAISE EXCEPTION 'synthetic principal late failure';END IF;RETURN NEW;END $$;CREATE TRIGGER qa_principal_fail BEFORE INSERT ON hamdee_private.ops_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.qa_principal_fail();");
 try{await assert.rejects(command(principal,body,key),/synthetic principal late failure/);}finally{await pool.query('DROP TRIGGER qa_principal_fail ON hamdee_private.ops_events;DROP FUNCTION hamdee_private.qa_principal_fail();');}
 assert.deepEqual(await snapshot(tables),before);await command(principal,body,key);assert.equal((await command(principal,body,key)).replay,true);
 await assert.rejects(left.ownerContext(identity,sql=>sql.query("UPDATE hamdee_private.principal_obligations SET amount=1 WHERE id=$1",[obligation.id])),/permission denied/);
 const count=(await pool.query('SELECT count(*)::int AS n FROM hamdee_private.principal_movements')).rows[0].n;
 await assert.rejects(left.ownerContext(identity,sql=>sql.query("INSERT INTO hamdee_private.principal_movements(id,obligation_id,kind,amount,business_date,method,account_id,money_entry_id,event_id) VALUES($1,$2,'repayment',1,'2026-11-12','cash',$3,$4,$5)",[randomUUID(),obligation.id,witness.cash,randomUUID(),randomUUID()])));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM hamdee_private.principal_movements')).rows[0].n,count);evidence.principalRollback={allSourceAndMoneyRowsRolledBack:true,sameKeyRetry:true,exactDecimals:true,immutablePrincipal:true,unfundedRawRepaymentDenied:true};
});

test('Native continuation: source-derived property and owner reports separate schedule, actual cash and supporting utility/asset references',async()=>{
 const p=(await left.mutate(identity,{action:'create',key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic native scheduled report property'}})).data;
 const room=await rental({action:'create-room',propertyId:p.id,code:'REPORT-01'}),tenant=await rental({action:'create-tenant',name:'Synthetic native report tenant'});
 await rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-10-01',monthlyRent:'53500',currency:'XTS',depositRequired:'0',dueTerms:'Synthetic explicitly confirmed full-month amount'});
 const expense=new ExpenseService(left),support=new SupportingRecordService(left),moneyCount=(await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n;
 const bill=async(category:string,amount:string,reference:string)=>(await command(expense,{action:'record-expense',propertyId:p.id,category,amount,currency:'XTS',expenseDate:'2026-10-03',vendorName:'Synthetic native report '+reference,reference})).data;
 await bill('landlord','34000','SYN-LANDLORD');await bill('service_charge','500','SYN-SERVICE');await bill('maintenance','3180','SYN-MAINTENANCE');
 for(const [index,amount] of ['6994','1062','674','934'].entries()){
  const reference=(await command(support,{action:'create-reference',kind:'utility-account',label:'Synthetic native utility '+index,propertyId:p.id,details:{serviceReference:'SYN-NATIVE-UTILITY-'+index},sourceReference:'Synthetic review cell '+index,reviewQuestions:['Q09'],status:'owner-confirmed'})).data;
  const cost=await bill('kahramaa',amount,'SYN-UTILITY-BILL-'+index);await command(support,{action:'link-expense',recordId:reference.id,expenseId:cost.id,reason:'Synthetic native reviewed linkage'});
 }
 const asset=(await command(support,{action:'create-reference',kind:'asset',label:'Synthetic native equipment',propertyId:p.id,sourceReference:'Synthetic asset source cell',details:{location:'Synthetic villa store',amount:'100.123456789123'},reviewQuestions:['Q13','Q14']})).data;
 await command(support,{action:'revise-reference',recordId:asset.id,expectedVersion:1,details:{location:'Synthetic reviewed room',amount:'100.123456789123'},reason:'Synthetic location history'});
 const report=await new SourceReportService(left).overview(identity,{month:'2026-10',asOf:'2026-10-31',propertyId:String(p.id)}),row=report.propertyReports[0];assert.equal(row.currency,'XTS');assert.equal(row.scheduledRentMinor,'5350000');assert.equal(row.scheduledResultMinor,'615600');assert.equal(row.kahramaaMinor,'966400');assert.equal(row.receivedRentMinor,'0');assert.equal(row.actualPaidMinor,'0');assert.equal((row.utilityAccounts as Row[]).length,4);assert.equal((row.utilityBills as Row[]).length,4);assert.equal(row.ownerShareMinor,null);assert.equal(report.ownerSummary.propertyRows[0].extraMinor,null);
 const references=await support.overview(identity,{propertyId:String(p.id)});assert.equal(references.revisions.filter(record=>record.id===asset.id).length,2);assert.equal((references.records.find(record=>record.id===asset.id)!.details as Row).currency,undefined);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n,moneyCount);evidence.reports={currency:'XTS explicitly synthetic; not inferred from source',scheduledRent:'53500',recordedCosts:'47344',scheduledResult:'6156',actualReceived:'0',actualPaid:'0',utilityAccounts:4,share:null,extra:null,assetRevisions:2,noFinancialPostingsFromReportOrReferences:true};
});

test('Native continuation: database and app-process restarts retain source records, corrections, private bytes, counts and fresh owner access',async()=>{
 assert.ok(cluster);const tables=['properties','tenants','room_occupancy_confirmations','property_documents','car_source_references','rent_collections','property_expenses','expense_payments','customer_documents','security_cheque_events','financial_corrections','collector_reconciliations','principal_obligations','principal_movements','principal_corrections','ops_money','ops_commands'],before=await snapshot(tables),priorPid=cluster.evidence().ownedPid;
 await disconnect();await cluster.restart();assert.notEqual(cluster.evidence().ownedPid,priorPid);connect();assert.deepEqual(await snapshot(tables),before);
 assert.equal((await new CustomerService(left).getDocument(identity,witness.privateDocument)).content.toString('hex'),witness.privateBytes);
 let app=await startOwnerAppProcess(backendConnection),jar=new OwnerCookieJar();const firstPid=app.pid;
 const request=async(method:string,route:string,body?:Row)=>{const response=await fetch(app.url+route,{method,headers:{Cookie:jar.header(),Origin:app.url,'X-Hamdee-CSRF':jar.csrfToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});await jar.accept(response);return response;};
 const login=async()=>{assert.equal((await request('GET','/api/hamdee/auth/state')).status,200);assert.equal((await request('POST','/api/hamdee/auth/login',{email:input.email,password:input.password})).status,200);};
 try{await login();await app.close();app=await startOwnerAppProcess(backendConnection);jar=new OwnerCookieJar();await login();assert.notEqual(app.pid,firstPid);const response=await request('GET','/api/hamdee/v1/customers/'+witness.customer+'?asOf=2026-11-30');assert.equal(response.status,200);const profile=(await response.json()).data;assert.equal(profile.customer.id,witness.customer);assert.equal(profile.customer.balances[0].outstandingMinor,'80000');
  await pool.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[witness.owner]);assert.equal((await request('GET','/api/hamdee/v1/customers/documents/'+witness.privateDocument)).status,401);
 }finally{await pool.query('UPDATE hamdee_private.app_users SET enabled=true WHERE id=$1',[witness.owner]);await app.close();}
 evidence.restart={priorEnginePid:priorPid,newEnginePid:cluster.evidence().ownedPid,priorAppPid:firstPid,newAppPid:app.pid,allSnapshotsEqual:true,privateBytesPreserved:true,freshOwnerLogin:true,ownerDisablementDeniesDocument:true};
});
