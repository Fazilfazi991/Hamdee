import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/fixture';
import {createOwnerQaFixture} from './support/owner-crm-harness';

const header='X-Hamdee-Property-Revision';
const revision=(id:string,version:number)=>`"property:${id}:${version}"`;
async function setup(t:TestContext){const f=await fixture();t.after(()=>f.pg.close());return f;}
async function json(response:Response,status:number,code?:string){
  const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('X-Request-Id'),body.requestId);
  if(code)assert.equal(body.error?.code,code);return body;
}
async function count(f:Awaited<ReturnType<typeof fixture>>,id:string){
  return {property:(await f.pg.query<{version:number;name:string}>('SELECT version,name FROM hamdee_private.properties WHERE id=$1',[id])).rows[0],
    history:(await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.audit_events WHERE property_id=$1',[id])).rows[0].count,
    commands:(await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.commands WHERE property_id=$1',[id])).rows[0].count};
}
function request(f:Awaited<ReturnType<typeof fixture>>,id:string,headers:Record<string,string>,name='Synthetic updated property',origin='https://synthetic.invalid'){
  return new Request(origin+'/api/hamdee/v1/properties/'+id,{method:'PATCH',headers:{Origin:origin,
    Authorization:'Bearer '+f.users.admin.token,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers},body:JSON.stringify({name})});
}
// Explicit model of the Coordinator-observed intermediary failure. It runs the
// actual application handler first, then applies a response-ETag If-Match check.
// This reproduces the reported CDN outcome; it does not call or emulate all of Vercel.
async function observedConditionalIntermediary(req:Request,handle:(request:Request)=>Promise<Response>){
  const response=await handle(req),condition=req.headers.get('If-Match'),etag=response.headers.get('ETag');
  if(response.ok&&condition!==null&&etag!==null&&condition!==etag)return new Response(null,{status:412});
  return response;
}

test('Property revision: actual handler plus observed conditional intermediary shows legacy postcommit empty412; custom header keeps JSON',async t=>{
  const f=await setup(t),legacy=await f.create('admin','Synthetic legacy condition');
  const lost=await observedConditionalIntermediary(request(f,legacy.id,{'If-Match':revision(legacy.id,1)},'Synthetic legacy committed','http://127.0.0.1:4181'),f.handle);
  assert.equal(lost.status,412);assert.equal(await lost.text(),'');
  const legacySaved=await count(f,legacy.id);assert.equal(legacySaved.property.version,2);assert.equal(legacySaved.history,2);
  const current=await f.create('admin','Synthetic application revision');
  const delivered=await observedConditionalIntermediary(request(f,current.id,{[header]:revision(current.id,1)}),f.handle);
  assert.equal(delivered.headers.get('ETag'),revision(current.id,2));const body=await json(delivered,200);
  assert.equal(body.data.version,2);assert.equal((await count(f,current.id)).history,2);
});

test('Property revision: stale custom revision returns application JSON412 without changing record, history or command ledger',async t=>{
  const f=await setup(t),p=await f.create();
  await json(await f.handle(request(f,p.id,{[header]:revision(p.id,1)})),200);const before=await count(f,p.id);
  await json(await observedConditionalIntermediary(request(f,p.id,{[header]:revision(p.id,1)},'Synthetic stale overwrite'),f.handle),412,'VERSION_CONFLICT');
  assert.deepEqual(await count(f,p.id),before);
});

test('Property revision: missing, malformed, unsafe, mismatched and ambiguous headers never mutate',async t=>{
  const f=await setup(t),p=await f.create(),before=await count(f,p.id);
  await json(await f.handle(request(f,p.id,{})),428,'PRECONDITION_REQUIRED');
  for(const value of ['1',`property:${p.id}:1`,revision(randomUUID(),1),revision(p.id,0),revision(p.id,-1),
    `"property:${p.id}:1.5"`,`"property:${p.id}:9007199254740992"`,revision(p.id,1)+', '+revision(p.id,1),'*'])
    await json(await f.handle(request(f,p.id,{[header]:value})),428,'PRECONDITION_REQUIRED');
  for(const legacy of [revision(p.id,1),revision(p.id,2)])
    await json(await f.handle(request(f,p.id,{[header]:revision(p.id,1),'If-Match':legacy})),400,'AMBIGUOUS_REVISION');
  await json(await f.handle(request(f,p.id,{'If-Match':revision(p.id,1)})),428,'PRECONDITION_REQUIRED');
  assert.deepEqual(await count(f,p.id),before);
});

test('Property revision: current custom revision replay is stable and changed payload cannot reuse its key',async t=>{
  const f=await setup(t),p=await f.create(),key=randomUUID(),headers={[header]:revision(p.id,1),'Idempotency-Key':key};
  const first=await json(await f.handle(request(f,p.id,headers)),200),before=await count(f,p.id);
  const retried=await observedConditionalIntermediary(request(f,p.id,headers),f.handle);assert.equal(retried.headers.get('Idempotent-Replay'),'true');
  assert.equal(retried.headers.get('ETag'),revision(p.id,2));const second=await json(retried,200);assert.deepEqual(second.data,first.data);
  assert.deepEqual(await count(f,p.id),before);
  await json(await f.handle(request(f,p.id,headers,'Synthetic changed replay')),409,'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(await count(f,p.id),before);
});

test('Property revision: custom header protects archive/restore and read ETags remain unchanged',async t=>{
  const f=await setup(t),p=await f.create();
  const command=(action:string,version:number)=>new Request('https://synthetic.invalid/api/hamdee/v1/properties/'+p.id+'/'+action,{method:'POST',
    headers:{Origin:'https://synthetic.invalid',Authorization:'Bearer '+f.users.admin.token,'Content-Type':'application/json','Idempotency-Key':randomUUID(),[header]:revision(p.id,version)},
    body:JSON.stringify({reason:'Synthetic lifecycle review'})});
  assert.equal((await json(await f.handle(command('archive',1)),200)).data.version,2);
  assert.equal((await json(await f.handle(command('restore',2)),200)).data.version,3);
  const read=await f.handle(new Request('https://synthetic.invalid/api/hamdee/v1/properties/'+p.id,{headers:{Authorization:'Bearer '+f.users.admin.token}}));
  assert.equal(read.headers.get('ETag'),revision(p.id,3));assert.equal((await json(read,200)).data.version,3);
});

test('Property revision: owner cookie/CSRF composition delivers new revision cookies and keeps stale writes closed',async t=>{
  const f=await createOwnerQaFixture();t.after(()=>f.close());await f.login();
  const p=(await json(await f.request('POST','/api/hamdee/v1/properties',{name:'Synthetic protected property'},{'Idempotency-Key':randomUUID()}),201)).data;
  const initial=f.jar.values.get('hamdee_owner');
  const response=await f.request('PATCH','/api/hamdee/v1/properties/'+p.id,{name:'Synthetic protected edit'},{'Idempotency-Key':randomUUID(),[header]:revision(p.id,1)});
  assert.equal(response.headers.get('ETag'),revision(p.id,2));assert.equal((await json(response,200)).data.version,2);
  assert.notEqual(f.jar.values.get('hamdee_owner'),initial);assert.ok(response.headers.getSetCookie().some(line=>line.startsWith('hamdee_owner=')));
  await json(await f.request('PATCH','/api/hamdee/v1/properties/'+p.id,{name:'Synthetic CSRF rejection'},{'Idempotency-Key':randomUUID(),[header]:revision(p.id,2),'X-Hamdee-CSRF':''}),403,'CSRF_REJECTED');
  await json(await f.request('PATCH','/api/hamdee/v1/properties/'+p.id,{name:'Synthetic stale rejection'},{'Idempotency-Key':randomUUID(),[header]:revision(p.id,1)}),412,'VERSION_CONFLICT');
  assert.equal((await f.pg!.query<{version:number}>('SELECT version FROM hamdee_private.properties WHERE id=$1',[p.id])).rows[0].version,2);
});
