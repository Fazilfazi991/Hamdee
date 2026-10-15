import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { Client, type PoolClient } from 'pg';
import { hostedConnectionOptions,guardHostedTransaction,HAMDEE_DEVELOPMENT_PROJECT,reviewedHostedDatabasePins,type HostedDatabasePins } from '../src/hosted-database';
import { runTransaction } from '../src/database';
import { handleOwnerAuthRequest,handleOwnerPropertyRequest } from '../src/owner-runtime';

// Synthetic configuration only. No connection or DNS request is made.
const pins:HostedDatabasePins={projectRef:HAMDEE_DEVELOPMENT_PROJECT,host:'synthetic-singapore.pooler.supabase.com',port:6543,
  database:'postgres',user:`hamdee_backend.${HAMDEE_DEVELOPMENT_PROJECT}`,mode:'transaction'};
const url=`postgresql://${pins.user}:SYNTHETIC_PASSWORD@${pins.host}:${pins.port}/${pins.database}`;
test('Hosted preparation: verified TLS, bounded pool and exact pins with no URL-parser overrides',()=>{
  const config=hostedConnectionOptions(url,pins),ssl=config.ssl as ConnectionOptions;
  assert.equal(ssl.rejectUnauthorized,true);assert.equal(ssl.minVersion,'TLSv1.2');assert.equal(ssl.servername,pins.host);
  assert.equal(ssl.checkServerIdentity,checkServerIdentity);assert.equal(config.max,2);assert.equal(config.connectionTimeoutMillis,3000);
  assert.equal(config.connectionString,undefined);assert.equal(config.user,pins.user);assert.equal(config.database,'postgres');
  const client=new Client(config);assert.equal(client.host,pins.host);assert.equal(client.port,6543);
  assert.throws(()=>hostedConnectionOptions(url,null));assert.deepEqual(reviewedHostedDatabasePins,{"projectRef":"dytlzfwbgeuhzgzemqsf","host":"aws-0-ap-southeast-1.pooler.supabase.com","port":6543,"database":"postgres","user":"hamdee_backend.dytlzfwbgeuhzgzemqsf","mode":"transaction"});
});
test('Hosted preparation: wrong project/host/port/database/user, privileged login and connection parameters fail closed',()=>{
  for(const changed of [url+'?sslmode=no-verify',url+'?options=-c%20role=postgres',url+'#override',
    url.replace(pins.host,'other.pooler.supabase.com'),url.replace(':6543',':5432'),url.replace('/postgres','/other'),
    url.replace(pins.user,'postgres.'+HAMDEE_DEVELOPMENT_PROJECT),url.replace(pins.user,'hamdee_backend.otherproject'),
    url.replace('SYNTHETIC_PASSWORD',''),url.replace('SYNTHETIC_PASSWORD','%00'),url.replace('SYNTHETIC_PASSWORD','%GG'),
    url.replace('postgresql:','https:'),'not a url']){
    assert.throws(()=>hostedConnectionOptions(changed,pins),error=>{
      assert.doesNotMatch(String(error),/SYNTHETIC_PASSWORD|pooler\.supabase|otherproject/);return true;
    });
  }
  for(const patch of [{projectRef:'other'},{host:'127.0.0.1'},{user:'postgres'},{port:5432},{mode:'session'}])
    assert.throws(()=>hostedConnectionOptions(url,{...pins,...patch} as HostedDatabasePins));
  const direct:HostedDatabasePins={...pins,mode:'direct',host:`db.${HAMDEE_DEVELOPMENT_PROJECT}.supabase.co`,user:'hamdee_backend',port:5432};
  assert.throws(()=>hostedConnectionOptions(`postgres://hamdee_backend:synthetic@${direct.host}:5432/postgres`,direct));
  assert.throws(()=>hostedConnectionOptions(url,pins,'not a CA certificate'));
});
test('Hosted preparation: unrelated PG defaults and disabled TLS validation cannot leak into pg',()=>{
  for(const [key,value] of [['PGOPTIONS','-c role=postgres'],['PGHOST','other.invalid'],['PGPASSWORD','OTHER_PASSWORD'],['PGREPLICATION','database'],['PGSSLMODE','no-verify'],['NODE_TLS_REJECT_UNAUTHORIZED','0']]){
    const prior=process.env[key];process.env[key]=value;
    try{assert.throws(()=>hostedConnectionOptions(url,pins));}
    finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;}
  }
});

function fakeClient(patch:Partial<{safe:boolean;marker:Partial<Record<string,string>>;commitError:boolean}>={}){
  const calls:string[]=[];let discard:unknown;
  const marker={app_id:'hamdee',environment:'synthetic-development',project_ref:HAMDEE_DEVELOPMENT_PROJECT,data_class:'synthetic_only',...patch.marker};
  const client={async query(text:string){calls.push(text);if(text==='COMMIT'&&patch.commitError)throw new Error('Synthetic commit uncertainty');
    return {rows:text.includes(' AS safe FROM')?[{safe:patch.safe??true}]:text.startsWith('SELECT app_id')?[marker]:[]};},release(value:boolean){discard=value;}} as unknown as PoolClient;
  return {client,calls,discard:()=>discard};
}
test('Hosted transaction: guards run within BEGIN; success commits and all denied marker/role states rollback before callback',async()=>{
  for(const patch of [{safe:false},{marker:{project_ref:'other'}},{marker:{environment:'local-test'}},{marker:{data_class:'real'}},{marker:{app_id:'other'}}]){
    const f=fakeClient(patch);let work=false;
    await assert.rejects(()=>runTransaction(f.client,sql=>guardHostedTransaction(sql,async()=>{work=true;})));
    assert.equal(work,false);assert.equal(f.calls[0],'BEGIN');assert.equal(f.calls.at(-1),'ROLLBACK');assert.equal(f.discard(),true);
  }
  const f=fakeClient();assert.equal(await runTransaction(f.client,sql=>guardHostedTransaction(sql,async()=>42)),42);
  assert.equal(f.calls[0],'BEGIN');assert.equal(f.calls.at(-1),'COMMIT');assert.equal(f.discard(),false);
  assert.ok(f.calls.includes('SET LOCAL ROLE hamdee_runtime'));assert.ok(f.calls.includes('SET LOCAL search_path=pg_catalog'));
  assert.ok(f.calls.filter(x=>x.startsWith('SET LOCAL')).length>=5);
});
test('Hosted transaction: callback failure and uncertain COMMIT discard the connection without silent retry',async()=>{
  for(const commitError of [false,true]){
    const f=fakeClient({commitError});let writes=0;
    await assert.rejects(()=>runTransaction(f.client,sql=>guardHostedTransaction(sql,async()=>{writes++;if(!commitError)throw new Error('Synthetic audit unavailable');})));
    assert.equal(writes,1);assert.equal(f.calls.at(-1),'ROLLBACK');assert.equal(f.discard(),true);
  }
});
test('Hosted runtime: environment inputs cannot activate pending source pins or expose protected data',async()=>{
  const keys={HAMDEE_OWNER_RUNTIME_APPROVAL:'approved-development-owner-runtime',HAMDEE_DATABASE_MODE:'hosted-development',
    HAMDEE_HOSTED_DATABASE_APPROVAL:'approved-synthetic-development-database',VERCEL_ENV:'preview'};
  const previous=new Map(Object.keys(keys).map(key=>[key,process.env[key]]));Object.assign(process.env,keys);
  try{
    for(const [method,path] of [['GET','/api/hamdee/auth/state'],['GET','/api/hamdee/v1/properties'],['POST','/api/hamdee/v1/properties']]){
      const request=new Request('https://synthetic.invalid'+path,{method});
      const response=path.includes('/auth/')?await handleOwnerAuthRequest(request):await handleOwnerPropertyRequest(request);
      assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CONFIGURATION_UNAVAILABLE');
    }
  }finally{for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
