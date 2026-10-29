import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture,startOwnerBrowserHarness} from './support/owner-crm-harness';
import {DocumentService} from '../src/documents';
import type {PropertyService} from '../src/service';
import type {Identity} from '../src/auth';

const base='/api/hamdee/v1';
const bytes=Buffer.from('%PDF-1.4\n% synthetic document only\n%%EOF');
const input=(propertyId:string,roomId?:string)=>({propertyId,...(roomId?{roomId}:{}),name:'Synthetic agreement.pdf',mimeType:'application/pdf',base64:bytes.toString('base64')});

test('Document upload waits for the property lifecycle lock and rejects an archive committed first',async()=>{
 const propertyId=randomUUID(),actorId=randomUUID();
 let release!:()=>void,started!:()=>void,archived=false,inserted=false;
 const waitForLock=new Promise<void>(resolve=>{release=resolve;}),lockRequested=new Promise<void>(resolve=>{started=resolve;});
 const sql={query:async(statement:string,params:unknown[]=[])=>{
  if(statement.includes('pg_advisory_xact_lock')){
   if(params[0]===`property:${propertyId}`){started();await waitForLock;}
   return {rows:[]};
  }
  if(statement.includes('FROM hamdee_private.property_documents WHERE actor_id='))return {rows:[]};
  if(statement.includes('FROM hamdee_private.properties WHERE id='))return {rows:[{id:propertyId,lifecycle_status:archived?'archived':'registered'}]};
  if(statement.includes('INSERT INTO hamdee_private.property_documents')){inserted=true;return {rows:[]};}
  throw new Error('Unexpected query in synthetic lock test');
 }};
 const propertyService={ownerContext:async(_identity:Identity,work:(sql:unknown,actor:string)=>Promise<unknown>)=>work(sql,actorId)} as unknown as PropertyService;
 const attempt=new DocumentService(propertyService).upload({issuer:'synthetic',subject:'synthetic'},input(propertyId),randomUUID());
 await Promise.race([lockRequested,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Property lifecycle lock was not acquired')),1000))]);
 archived=true;release();
 await assert.rejects(attempt,(error:{code?:string})=>error.code==='PROPERTY_ARCHIVED');
 assert.equal(inserted,false);
});
async function setup(){
 const f=await createOwnerQaFixture({migrationFiles:['012_local_private_documents.up.sql']});await f.login();
 const create=async(name:string)=>{const r=await f.request('POST',base+'/properties',{name},{'Idempotency-Key':randomUUID()});assert.equal(r.status,201);return (await r.json()).data.id as string;};
 const propertyId=await create('Synthetic villa one'),otherPropertyId=await create('Synthetic villa two');
 const r=await f.request('POST',base+'/rental',{action:'create-room',propertyId,code:'TEST-1',label:''},{'Idempotency-Key':randomUUID()});assert.equal(r.status,200);const roomId=(await r.json()).data.id as string;
 return {...f,propertyId,otherPropertyId,roomId};
}

test('Owner-only documents persist and download safely with exact idempotent replay',async t=>{
 const f=await setup();t.after(()=>f.close());const key=randomUUID(),body=input(f.propertyId,f.roomId);
 const first=await f.request('POST',base+'/documents',body,{'Idempotency-Key':key});assert.equal(first.status,200);const created=await first.json();assert.equal(created.replay,false);assert.equal(created.data.name,body.name);assert.equal(created.data.roomId,f.roomId);assert.equal(created.data.size,bytes.length);assert.doesNotMatch(JSON.stringify(created),/synthetic document only|base64|content_sha/);
 const replay=await f.request('POST',base+'/documents',body,{'Idempotency-Key':key});assert.equal(replay.status,200);assert.equal(replay.headers.get('Idempotent-Replay'),'true');assert.equal((await replay.json()).data.id,created.data.id);
 const conflict=await f.request('POST',base+'/documents',{...body,name:'Different.pdf'},{'Idempotency-Key':key});assert.equal(conflict.status,409);
 const listing=await f.request('GET',base+'/documents?propertyId='+f.propertyId+'&roomId='+f.roomId);assert.equal(listing.status,200);const listed=await listing.json();assert.equal(listed.data.items.length,1);assert.doesNotMatch(JSON.stringify(listed),/synthetic document only|base64|content_sha/);
 f.rebuildApplication();const file=await f.request('GET',base+'/documents/'+created.data.id);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'application/pdf');assert.match(file.headers.get('content-disposition')||'',/^attachment;/);assert.equal(file.headers.get('cache-control'),'private, no-store');assert.equal(file.headers.get('x-content-type-options'),'nosniff');assert.match(file.headers.get('content-security-policy')||'',/sandbox/);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
 await f.auth('POST','logout',{});const denied=await f.request('GET',base+'/documents/'+created.data.id);assert.equal(denied.status,401);assert.doesNotMatch(await denied.text(),/synthetic document only/);
});

test('Private image downloads preserve non-UTF-8 bytes for PNG and JPEG',async t=>{
 const f=await setup();t.after(()=>f.close());
 for(const [name,mimeType,content] of [
  ['Synthetic.png','image/png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0xff,0x80,0x00])],
  ['Synthetic.jpg','image/jpeg',Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0xff,0xd9])]
 ] as const){
  const upload=await f.request('POST',base+'/documents',{propertyId:f.propertyId,name,mimeType,base64:content.toString('base64')},{'Idempotency-Key':randomUUID()});
  assert.equal(upload.status,200);const document=(await upload.json()).data;
  const downloaded=await f.request('GET',base+'/documents/'+document.id);assert.equal(downloaded.status,200);
  assert.equal(downloaded.headers.get('content-type'),mimeType);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),content);
 }
});

test('Private PNG above 32 KiB uploads and downloads intact through browser HTTP transport',async t=>{
 const server=await startOwnerBrowserHarness({migrationFiles:['012_local_private_documents.up.sql']});t.after(()=>server.close());
 const f=server.fixture;await f.login();
 const property=await f.request('POST',base+'/properties',{name:'Synthetic binary transport villa'},{'Idempotency-Key':randomUUID()});
 assert.equal(property.status,201);const propertyId=(await property.json()).data.id;
 const content=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(40*1024,0x80)]);
 const upload=await fetch(server.url+base+'/documents',{method:'POST',headers:{Cookie:f.jar.header(),Origin:server.url,'Content-Type':'application/json','X-Hamdee-CSRF':f.jar.csrfToken,'Idempotency-Key':randomUUID()},body:JSON.stringify({propertyId,name:'Synthetic.png',mimeType:'image/png',base64:content.toString('base64')})});
 assert.equal(upload.status,200);const document=(await upload.json()).data;
 const downloaded=await fetch(server.url+base+'/documents/'+document.id,{headers:{Cookie:f.jar.header()}});
 assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('content-type'),'image/png');
 assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),content);
});

test('CSRF, membership, file size, filename, signature and property-room boundaries fail closed',async t=>{
 const f=await setup();t.after(()=>f.close());const write=(body:unknown,extra:Record<string,string>={})=>f.request('POST',base+'/documents',body,{'Idempotency-Key':randomUUID(),...extra});
 assert.equal((await write(input(f.propertyId),{'X-Hamdee-CSRF':'invalid'})).status,403);
 assert.equal((await write(input(f.otherPropertyId,f.roomId))).status,404);
 assert.equal((await write({...input(f.propertyId),name:'evil\r\nHeader: injected.pdf'})).status,422);
 assert.equal((await write({...input(f.propertyId),name:'../malicious.pdf'})).status,422);
 assert.equal((await write({...input(f.propertyId),base64:Buffer.from('<script>not a PDF</script>').toString('base64')})).status,422);
 assert.equal((await write({...input(f.propertyId),mimeType:'image/svg+xml'})).status,422);
 assert.equal((await write({...input(f.propertyId),base64:Buffer.alloc(1024*1024+1,0x41).toString('base64')})).status,422);
 const count=await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.property_documents');assert.equal(count.rows[0].n,0);
 await f.pg!.query('UPDATE hamdee_private.role_assignments SET portfolio=false WHERE id=$1',[f.member!.assignment]);
 assert.equal((await f.request('GET',base+'/documents?propertyId='+f.propertyId)).status,403);
 assert.equal((await write(input(f.propertyId))).status,403);
});
