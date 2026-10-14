import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client,type PoolClient } from 'pg';
import { localConnectionOptions,runTransaction } from '../src/database';
import { SupabaseIdentityProvider } from '../src/auth';
import { createHandler,unavailable } from '../src/http';
import type { PropertyService } from '../src/service';
import type { SecurityEvent } from '../src/security-log';
import { issuer } from './support/fixture';

test('UNIT: native adapter pins all connection fields despite unrelated PG environment defaults',()=>{
  const original=process.env.PGHOST;process.env.PGHOST='other-venture.invalid';
  try{const config=localConnectionOptions('postgres://synthetic:synthetic@127.0.0.1:55432/hamdee_dev_test');
    assert.equal(config.host,'127.0.0.1');assert.equal(config.ssl,false);assert.equal(config.options,'-c search_path=pg_catalog');assert.equal(config.port,55432);assert.equal(config.user,'synthetic');
  }finally{if(original===undefined)delete process.env.PGHOST;else process.env.PGHOST=original;}
});

test('UNIT: actual pg connection parser must not inherit another application PGOPTIONS',()=>{
  const original=process.env.PGOPTIONS;process.env.PGOPTIONS='-c role=another_venture';
  try{const client=new Client(localConnectionOptions('postgres://synthetic:synthetic@127.0.0.1:55432/hamdee_dev_test'));
    assert.equal((client as unknown as {connectionParameters:{options:string}}).connectionParameters.options,'-c search_path=pg_catalog');
  }finally{if(original===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=original;}
});

test('UNIT: rollback failure preserves original ambiguity and discards broken connection',async()=>{
  const original=new Error('Synthetic lost commit response');let discarded=false;
  const client={query:async(text:string)=>{if(text==='COMMIT')throw original;if(text==='ROLLBACK')throw new Error('Synthetic dead socket');return {rows:[]};},release:(destroy:boolean)=>{discarded=destroy;}} as unknown as PoolClient;
  await assert.rejects(()=>runTransaction(client,async()=>42),error=>error===original);assert.equal(discarded,true);
});

test('UNIT: SQL failure rolls back and healthy later transaction returns normally',async()=>{
  const commands:string[]=[];let release:unknown;
  const client={query:async(text:string)=>{commands.push(text);return {rows:[]};},release:(destroy:boolean)=>{release=destroy;}} as unknown as PoolClient;
  await assert.rejects(()=>runTransaction(client,async()=>{throw new Error('Synthetic SQL failure');}));
  assert.deepEqual(commands,['BEGIN','ROLLBACK']);assert.equal(release,true);
  assert.equal(await runTransaction(client,async()=>7),7);assert.equal(release,false);
});

test('MOCK PROVIDER: invalid IDs, anonymous accounts and rejected/expired sessions fail closed',async()=>{
  for(const user of [{id:'client-selected-admin'},{id:'12345678-1234-4123-8123-123456789012',is_anonymous:true},null]){
    const provider=new SupabaseIdentityProvider({auth:{getUser:async()=>({data:{user},error:null})}},issuer);
    await assert.rejects(()=>provider.validate(new Request('http://local',{headers:{Authorization:'Bearer synthetic'}})),/authorized account/);
  }
  assert.throws(()=>new SupabaseIdentityProvider({auth:{getUser:async()=>({data:{user:null},error:null})}},'http://another.invalid/auth/v1'));
});

test('UNIT: authentication logging contains only a fixed event, status and generated request ID',async()=>{
  const events:SecurityEvent[]=[];const handle=createHandler({validate:async()=>{throw new Error('SECRET TOKEN provider stack');}},{} as PropertyService,event=>events.push(event));
  const response=await handle(new Request('http://local/api/hamdee/v1/properties',{headers:{Authorization:'Bearer PRIVATE',Role:'admin'}}));
  assert.equal(response.status,503);assert.equal(events.length,1);assert.deepEqual(Object.keys(events[0]).sort(),['event','requestId','status']);
  assert.doesNotMatch(JSON.stringify(events)+await response.text(),/SECRET|PRIVATE|stack/);
  const rejecting=createHandler({validate:async()=>{const {ApiError}=await import('../src/errors');throw new ApiError(401,'UNAUTHENTICATED','Sign in with an authorized account.');}},{} as PropertyService,event=>events.push(event));
  assert.equal((await rejecting(new Request('http://local/api/hamdee/v1/properties'))).status,401);assert.equal(events[1].event,'authentication_rejected');
});

test('UNIT: logger failure or arbitrary deployment test-auth variables cannot authorize a request',async()=>{
  const original=process.env.HAMDEE_TEST_AUTH;process.env.HAMDEE_TEST_AUTH='admin';
  try{assert.equal((await unavailable()).status,503);
    const handle=createHandler({validate:async()=>{throw new Error('Invalid');}},{} as PropertyService,()=>{throw new Error('Logging unavailable');});
    assert.equal((await handle(new Request('http://local/api/hamdee/v1/properties'))).status,503);
  }finally{if(original===undefined)delete process.env.HAMDEE_TEST_AUTH;else process.env.HAMDEE_TEST_AUTH=original;}
});
