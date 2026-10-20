import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.ok(f.calls.includes('SET LOCAL ROLE hamdee_runtime'));
  assert.equal(f.calls.length,6); // BEGIN, fixed settings, role guard, SET ROLE, marker, COMMIT.
  assert.match(f.calls[1],/pg_catalog\.set_config\('statement_timeout','10000ms',true\)/);
  assert.match(f.calls[1],/pg_catalog\.set_config\('lock_timeout','3000ms',true\)/);
  assert.match(f.calls[1],/pg_catalog\.set_config\('idle_in_transaction_session_timeout','10000ms',true\)/);
  assert.match(f.calls[1],/pg_catalog\.set_config\('search_path','pg_catalog',true\)/);
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

test('Hosted diagnostic: bounded fixed categories exclude secret canaries and retain generic failures without network',()=>{
  const env:NodeJS.ProcessEnv={NODE_ENV:'test'};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH','ComSpec'])if(process.env[name])env[name]=process.env[name]!;
  const code=`
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import {Pool} from 'pg';
    let fetches=0,sockets=0;
    globalThis.fetch=async()=>{fetches++;throw new Error('PRIVATE_FETCH_CANARY');};
    net.Socket.prototype.connect=function(){sockets++;throw new Error('PRIVATE_SOCKET_CANARY');};
    const warnings=[];const loggerFails=process.argv[1]==='throws';
    console.warn=(...args)=>{if(loggerFails)throw new Error('PRIVATE_LOGGER_CANARY');warnings.push(args);};
    const {hostedConnectionOptions,HostedPostgresDatabase}=await import('./src/hosted-database.ts');
    const {handleOwnerAuthRequest,handleOwnerPropertyRequest}=await import('./src/owner-runtime.ts');
    const project='dytlzfwbgeuhzgzemqsf';
    const pins={projectRef:project,host:'aws-0-ap-southeast-1.pooler.supabase.com',port:6543,database:'postgres',
      user:'hamdee_backend.'+project,mode:'transaction'};
    const url='postgres://'+pins.user+':PRIVATE_PASSWORD_CANARY@'+pins.host+':6543/postgres';
    const reject=(work)=>{for(let i=0;i<2;i++)assert.throws(work,error=>{
      assert.equal(error.status,503);assert.equal(error.code,'ENVIRONMENT_MISMATCH');
      assert.equal(error.message,'The dedicated HAMDEE development database is unavailable.');
      assert.deepEqual(Object.keys(error).sort(),['code','status']);
      assert.doesNotMatch(String(error),/CANARY|pooler|postgres:|password_encoding|tls_ca/);return true;
    });};
    process.env.PGOPTIONS='PRIVATE_PROCESS_CANARY';reject(()=>hostedConnectionOptions(url,pins));delete process.env.PGOPTIONS;
    reject(()=>hostedConnectionOptions(url,{...pins,projectRef:'PRIVATE_PROJECT_CANARY'}));
    reject(()=>hostedConnectionOptions(url+'?PRIVATE_URL_CANARY=1',pins));
    reject(()=>hostedConnectionOptions(url.replace('PRIVATE_PASSWORD_CANARY','%GGPRIVATE_PASSWORD_CANARY'),pins));
    reject(()=>hostedConnectionOptions(url,pins,'PRIVATE_CA_CANARY'));
    const originalOn=Pool.prototype.on;
    Pool.prototype.on=function(){throw new Error('PRIVATE_DRIVER_CANARY');};
    try{reject(()=>new HostedPostgresDatabase(url,pins));}finally{Pool.prototype.on=originalOn;}
    Object.assign(process.env,{
      HAMDEE_OWNER_RUNTIME_APPROVAL:'approved-development-owner-runtime',HAMDEE_APP_ID:'hamdee',
      HAMDEE_ENVIRONMENT:'development',HAMDEE_DATA_CLASS:'synthetic_only',HAMDEE_PROJECT_OWNER:'PRIVATE_OWNER_CANARY',
      HAMDEE_PROJECT_REF:project,HAMDEE_REGION:'ap-southeast-1',HAMDEE_RESIDENCY_DECISION:'approved_synthetic_development_only',
      HAMDEE_SUPABASE_URL:'https://'+project+'.supabase.co',HAMDEE_AUTH_ISSUER:'https://'+project+'.supabase.co/auth/v1',
      HAMDEE_AUTH_AUDIENCE:'authenticated',HAMDEE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_PRIVATE_KEY_CANARY',
      HAMDEE_OWNER_SUBJECT:'44440000-1111-4111-8111-111111111111',HAMDEE_OWNER_EMAIL:'private-email-canary@example.invalid',
      HAMDEE_OWNER_ORIGIN:'https://synthetic.invalid',HAMDEE_OWNER_COOKIE_KEY:Buffer.alloc(32,12).toString('base64url'),
      HAMDEE_DATABASE_MODE:'hosted-development',HAMDEE_HOSTED_DATABASE_APPROVAL:'approved-synthetic-development-database',
      HAMDEE_DATABASE_URL:url+'?PRIVATE_URL_CANARY=1',VERCEL_ENV:'preview',
      HAMDEE_OWNER_IDLE_MS:'900000',HAMDEE_OWNER_ABSOLUTE_MS:'28800000',HAMDEE_OWNER_CSRF_MS:'60000',
      HAMDEE_OWNER_AUTH_TIMEOUT_MS:'3000',HAMDEE_OWNER_RATE_WINDOW_MS:'60000',HAMDEE_OWNER_RATE_BOUNDS:'30',
      HAMDEE_OWNER_RATE_BACKOFF_MS:'60000'
    });
    for(const path of ['/api/hamdee/auth/state','/api/hamdee/v1/properties']){
      const request=new Request('https://synthetic.invalid'+path);
      const response=await(path.includes('/auth/')?handleOwnerAuthRequest(request):handleOwnerPropertyRequest(request));
      assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      const body=await response.json();assert.equal(body.error.code,'CONFIGURATION_UNAVAILABLE');
      assert.deepEqual(Object.keys(body).sort(),['error','requestId']);
      assert.doesNotMatch(JSON.stringify(body),/CANARY|stage|hosted_database|pooler|postgres:/);
    }
    const events=warnings.map(args=>{assert.equal(args.length,1);return JSON.parse(args[0]);});
    const expected=['process_environment','pins','url','password_encoding','tls_ca','driver_constructor']
      .map(stage=>({event:'hosted_database_configuration_unavailable',stage}));
    expected.push({event:'owner_configuration_unavailable',stage:'database_configuration'});
    assert.deepEqual(events,loggerFails?[]:expected);
    assert.doesNotMatch(JSON.stringify(warnings),/CANARY|postgres:|pooler\\.supabase|sb_publishable|BEGIN CERTIFICATE/);
    assert.equal(fetches,0);assert.equal(sockets,0);
  `;
  for(const mode of ['records','throws']){
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code,mode],{
      cwd:new URL('../',import.meta.url),env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  }
});
