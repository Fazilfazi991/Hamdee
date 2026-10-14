import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDevelopmentConfig,type ReviewedDevelopmentPins } from '../src/development-config';
import { prepareDevelopmentIdentityAdapter } from '../src/auth-preparation';

// Entirely synthetic offline config. No project key, DB password or provider
// credential is used. The real project record remains separate and incomplete.
const pins:ReviewedDevelopmentPins={projectRef:'abcdefghijklmnopqrst',ownerIdentifier:'SYNTHETIC OWNER',region:'SYNTHETIC REGION',residencyDecision:'SYNTHETIC RESIDENCY REVIEW',integrationApproval:'SYNTHETIC TEST ONLY',databaseHost:'approved-db.invalid',databasePort:6543,databaseName:'hamdee_synthetic',databaseUser:'synthetic_backend',sessionTransport:'bearer'};
const values={HAMDEE_APP_ID:'hamdee',HAMDEE_ENVIRONMENT:'development',HAMDEE_PROJECT_OWNER:pins.ownerIdentifier!,HAMDEE_REGION:pins.region!,HAMDEE_RESIDENCY_DECISION:pins.residencyDecision!,
  HAMDEE_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',HAMDEE_AUTH_ISSUER:'https://abcdefghijklmnopqrst.supabase.co/auth/v1',HAMDEE_AUTH_AUDIENCE:'authenticated',
  HAMDEE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_SYNTHETIC_TEST_ONLY_NOT_A_REAL_KEY',HAMDEE_DATABASE_URL:'postgres://synthetic_backend:SYNTHETIC_PASSWORD@approved-db.invalid:6543/hamdee_synthetic',HAMDEE_DATABASE_TLS:'verify-full',HAMDEE_SESSION_TRANSPORT:'bearer'};

test('OFFLINE CONFIG: reviewed dedicated development metadata validates without returning secrets',()=>{
  const config=validateDevelopmentConfig(values,pins);assert.equal(config.environment,'development');assert.equal(config.database.host,'approved-db.invalid');
  assert.doesNotMatch(JSON.stringify(config),/PASSWORD|publishable|databaseUrl/i);assert.ok(Object.isFrozen(config.database));
});
test('OFFLINE CONFIG: missing owner, residency, region, connection pins or approval fail closed',()=>{
  for(const field of ['ownerIdentifier','region','residencyDecision','integrationApproval','databaseHost','databaseName','databaseUser','databasePort','sessionTransport']as const)
    assert.throws(()=>validateDevelopmentConfig(values,{...pins,[field]:null}),/configuration is incomplete/);
});
test('OFFLINE CONFIG: another project, environment, issuer, database or connection override is rejected',()=>{
  for(const patch of [
    {HAMDEE_SUPABASE_URL:'https://zzzzzzzzzzzzzzzzzzzz.supabase.co'}, {HAMDEE_ENVIRONMENT:'production'},
    {HAMDEE_AUTH_ISSUER:'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/auth/v1'},{HAMDEE_AUTH_AUDIENCE:'admin'},
    {HAMDEE_DATABASE_URL:values.HAMDEE_DATABASE_URL+'?host=other-venture.invalid'},{HAMDEE_DATABASE_URL:values.HAMDEE_DATABASE_URL.replace('approved-db.invalid','other-db.invalid')},
    {HAMDEE_DATABASE_URL:values.HAMDEE_DATABASE_URL.replace('hamdee_synthetic','other_app')},{HAMDEE_DATABASE_TLS:'no-verify'},
    {HAMDEE_TEST_AUTH:'admin'},{NEXT_PUBLIC_HAMDEE_DATABASE_URL:values.HAMDEE_DATABASE_URL},{HAMDEE_SUPABASE_ADMIN_KEY:'SYNTHETIC_ADMIN_SECRET'}
  ])assert.throws(()=>validateDevelopmentConfig({...values,...patch},pins));
});
test('OFFLINE CONFIG: generic venture variables cannot fill missing dedicated configuration',()=>{
  assert.throws(()=>validateDevelopmentConfig({SUPABASE_URL:values.HAMDEE_SUPABASE_URL,DATABASE_URL:values.HAMDEE_DATABASE_URL},pins));
  assert.doesNotThrow(()=>validateDevelopmentConfig({...values,SUPABASE_URL:'https://other-venture.invalid'},pins));
});
test('OFFLINE CONFIG: errors do not expose supplied credentials, hostnames or tokens',()=>{
  try{validateDevelopmentConfig({...values,HAMDEE_DATABASE_URL:'postgres://PRIVATE_USER:PRIVATE_PASSWORD@PRIVATE_HOST/wrong'},pins);assert.fail('must reject');}
  catch(error){assert.doesNotMatch(String(error),/PRIVATE|approved-db|supabase\.co/);assert.equal((error as {status:number}).status,503);}
});
test('OFFLINE CONFIG: server-cookie choice requires a separately approved transport and secret',()=>{
  const cookie={...pins,sessionTransport:'server_cookie' as const},input={...values,HAMDEE_SESSION_TRANSPORT:'server_cookie'};
  assert.throws(()=>validateDevelopmentConfig(input,cookie));assert.doesNotThrow(()=>validateDevelopmentConfig({...input,HAMDEE_SESSION_SECRET:'SYNTHETIC_SECRET_FOR_OFFLINE_TESTING_ONLY'},cookie));
});
test('MOCK PROVIDER: prepared adapter binds the reviewed project without calling the provider at construction',async()=>{
  let calls=0;const client={auth:{getUser:async()=>{calls++;return {data:{user:{id:'12345678-1234-4123-8123-123456789012'}},error:null};}}};
  assert.throws(()=>prepareDevelopmentIdentityAdapter(values,pins,{client,projectUrl:'https://wrong-project.invalid'}));assert.equal(calls,0);
  const adapter=prepareDevelopmentIdentityAdapter(values,pins,{client,projectUrl:values.HAMDEE_SUPABASE_URL});assert.equal(calls,0);
  const identity=await adapter.validate(new Request('http://local',{headers:{Authorization:'Bearer SYNTHETIC_TOKEN'}}));assert.equal(calls,1);assert.equal(identity.issuer,values.HAMDEE_AUTH_ISSUER);
});

test('OFFLINE CONFIG: sanitized fixture remains blocked pending accountable owner and integration approval',async()=>{
  const review=JSON.parse(await readFile(new URL('./support/fixtures/development-config-blocked.json',import.meta.url),'utf8'));
  assert.equal(review.projectRef,'dytlzfwbgeuhzgzemqsf');assert.equal(review.region,'ap-southeast-1');assert.equal(review.ownerIdentifier,null);assert.equal(review.integrationApproval,null);
  assert.equal(review.hostedConnectionPerformed,false);assert.throws(()=>validateDevelopmentConfig({},review));
});
