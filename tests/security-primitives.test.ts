import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createCipheriv } from 'node:crypto';
import { createTokenEnvelope,TokenEnvelopeError } from '../src/security/token-envelope';
import { createCsrfProtector,CsrfError } from '../src/security/csrf';
import type { IdentityBinding,ServerTokenPair } from '../src/security/contracts';
import { validateSessionPolicy } from '../src/security/session-policy';

const binding:IdentityBinding={provider:'supabase',appId:'hamdee',environment:'development',dataClass:'synthetic_only',projectRef:'abcdefghijklmnopqrst',issuer:'https://abcdefghijklmnopqrst.supabase.co/auth/v1',audience:'authenticated'};
const tokens:ServerTokenPair={accessToken:'SYNTHETIC_ACCESS_CP2',refreshToken:'SYNTHETIC_REFRESH_CP2'};
function random(){let count=0;return {bytes:(length:number)=>createHash('sha256').update('SYNTHETIC_NONCE_'+(++count)).digest().subarray(0,length)};}
const make=()=>createTokenEnvelope({keys:{first:new Uint8Array(32).fill(61),second:new Uint8Array(32).fill(62)},activeKeyVersion:'first',random:random()});
const csrfBinding={identityBinding:binding,purpose:'session' as const,handleHash:'1'.repeat(64)};
const policy=()=>validateSessionPolicy({idleTimeout:20000,absoluteTimeout:120000,jwtLifetime:12000,refreshLead:4000,refreshLease:2000,clockTolerance:100,stepUpMaxAge:8000,
  allowedOrigins:['https://primitives.hamdee.invalid'],redirectAllowlist:['https://primitives.hamdee.invalid/auth/callback'],logoutScope:'local',trustedProxyPolicy:{mode:'none'},
  limits:Object.fromEntries(['login','refresh','mfa','recovery','invitation','write'].map(k=>[k,{bounds:3,window:1000,backoff:250}])),
  mfa:{administratorRequired:true,requireLiveAdminSession:true,otherRoles:'optional',factor:'totp',stepUpActions:['membership_change','factor_change','recovery_approval','administrator_activation']},disablementBoundary:'recheck_at_commit'});
test('CP2 AES-GCM roundtrip produces bounded authenticated ciphertext without plaintext',async()=>{
  const e=make(),sealed=await e.seal(tokens,binding);assert.deepEqual(await e.open(sealed,binding),tokens);
  assert.ok(Object.isFrozen(sealed));assert.equal(Buffer.from(sealed.nonce,'base64url').length,12);
  assert.ok(Buffer.from(sealed.ciphertext,'base64url').length>16);assert.doesNotMatch(JSON.stringify(sealed),/SYNTHETIC/);
});
test('CP2 envelope keys and selected version are copied at construction',async()=>{
  const key=new Uint8Array(32).fill(61),options={keys:{first:key},activeKeyVersion:'first',random:random()};const e=createTokenEnvelope(options);
  key.fill(99);options.activeKeyVersion='unknown';options.random.bytes=()=>{throw new Error('Do not call a replaced method');};
  const sealed=await e.seal(tokens,binding);assert.equal(sealed.keyVersion,'first');
  const reader=createTokenEnvelope({keys:{first:new Uint8Array(32).fill(61)},activeKeyVersion:'first',random:random()});assert.deepEqual(await reader.open(sealed,binding),tokens);
});
test('CP2 key rotation decrypts retained versions and rejects removed or relabelled versions',async()=>{
  const old=make(),sealed=await old.seal(tokens,binding);
  const rotated=createTokenEnvelope({keys:{first:new Uint8Array(32).fill(61),second:new Uint8Array(32).fill(62)},activeKeyVersion:'second',random:random()});
  assert.deepEqual(await rotated.open(sealed,binding),tokens);assert.equal((await rotated.seal(tokens,binding)).keyVersion,'second');
  const retired=createTokenEnvelope({keys:{second:new Uint8Array(32).fill(62)},activeKeyVersion:'second',random:random()});await assert.rejects(()=>retired.open(sealed,binding),TokenEnvelopeError);
  await assert.rejects(()=>rotated.open({...sealed,keyVersion:'second'},binding),TokenEnvelopeError);
});
test('CP2 algorithm and key version are authenticated even when key bytes are equal',async()=>{
  const e=createTokenEnvelope({keys:{a:new Uint8Array(32).fill(1),b:new Uint8Array(32).fill(1)},activeKeyVersion:'a',random:random()}),sealed=await e.seal(tokens,binding);
  await assert.rejects(()=>e.open({...sealed,keyVersion:'b'},binding));await assert.rejects(()=>e.open({...sealed,algorithm:'none'},binding));
});
test('CP2 envelopes bind all identity fields and a coherent different project',async()=>{
  const e=make(),sealed=await e.seal(tokens,binding);
  for(const key of Object.keys(binding))await assert.rejects(()=>e.open(sealed,{...binding,[key]:'wrong'} as IdentityBinding),TokenEnvelopeError);
  const other={...binding,projectRef:'zzzzzzzzzzzzzzzzzzzz',issuer:'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/auth/v1'};await assert.rejects(()=>e.open(sealed,other),TokenEnvelopeError);
});
test('CP2 nonce, tag and ciphertext alterations all fail authenticated decrypt',async()=>{
  const e=make(),sealed=await e.seal(tokens,binding);
  for(const field of ['nonce','ciphertext'] as const){const bytes=Buffer.from(sealed[field],'base64url');for(const position of [0,bytes.length-1]){
    const changed=Buffer.from(bytes);changed[position]^=1;await assert.rejects(()=>e.open({...sealed,[field]:changed.toString('base64url')},binding),TokenEnvelopeError);
  }}
});
test('CP2 malformed, noncanonical, overlong and truncated encodings reject',async()=>{
  const e=make(),sealed=await e.seal(tokens,binding);
  for(const nonce of ['',sealed.nonce+'=','AA',sealed.nonce+'\n','!'.repeat(16),'A'.repeat(1000)])await assert.rejects(()=>e.open({...sealed,nonce},binding));
  for(const ciphertext of ['', 'A'.repeat(20),sealed.ciphertext+'=',sealed.ciphertext+'\n','A'.repeat(45000)])await assert.rejects(()=>e.open({...sealed,ciphertext},binding));
  await assert.rejects(()=>e.open({...sealed,unknown:'field'} as typeof sealed,binding));
});
test('CP2 encryption rejects repeated or malformed injected nonces',async()=>{
  const fixed=createTokenEnvelope({keys:{key:new Uint8Array(32)},activeKeyVersion:'key',random:{bytes:()=>new Uint8Array(12)}});
  await fixed.seal(tokens,binding);await assert.rejects(()=>fixed.seal(tokens,binding),TokenEnvelopeError);
  const short=createTokenEnvelope({keys:{key:new Uint8Array(32)},activeKeyVersion:'key',random:{bytes:()=>new Uint8Array(11)}});await assert.rejects(()=>short.seal(tokens,binding));
});
test('CP2 secret configuration and invalid token values fail without echoing secret material',async()=>{
  for(const size of [0,16,31,33])assert.throws(()=>createTokenEnvelope({keys:{secret:new Uint8Array(size)},activeKeyVersion:'secret',random:random()}),TokenEnvelopeError);
  assert.throws(()=>createTokenEnvelope({keys:{a:new Uint8Array(32)},activeKeyVersion:'missing',random:random()}));
  const e=make();for(const token of ['', 'SECRET TOKEN', 'é', 'A'.repeat(16385)]){
    await assert.rejects(()=>e.seal({accessToken:token,refreshToken:tokens.refreshToken},binding),error=>error instanceof TokenEnvelopeError&&!String(error).includes(token||'NEVER_MATCH'));
  }
});
test('CP2 authenticated plaintext still requires exact token projection and valid UTF8',async()=>{
  const key=Buffer.alloc(32,61),nonce=Buffer.alloc(12,4),e=make();
  for(const plaintext of [Buffer.from('{"accessToken":"a","refreshToken":"b","roles":["admin"]}'),Buffer.from([0xc0,0xaf])]){
    const c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(Buffer.from(JSON.stringify(['hamdee/server-token-envelope/v1','aes-256-gcm-v1','first',binding.provider,binding.appId,binding.environment,binding.dataClass,binding.projectRef,binding.issuer,binding.audience])));
    const ciphertext=Buffer.concat([c.update(plaintext),c.final(),c.getAuthTag()]).toString('base64url');
    await assert.rejects(()=>e.open({algorithm:'aes-256-gcm-v1',keyVersion:'first',nonce:nonce.toString('base64url'),ciphertext},binding),TokenEnvelopeError);
  }
});
test('CP2 HMAC CSRF separates handles, purposes, projects and key material',()=>{
  const key=new Uint8Array(32).fill(80),csrf=createCsrfProtector(key),token=csrf.issue(csrfBinding);key.fill(0);
  assert.equal(csrf.verify(token,csrfBinding),true);assert.equal(createCsrfProtector(new Uint8Array(32).fill(80)).verify(token,csrfBinding),true);
  assert.equal(createCsrfProtector(new Uint8Array(32).fill(81)).verify(token,csrfBinding),false);
  assert.equal(csrf.verify(token,{...csrfBinding,handleHash:'2'.repeat(64)}),false);assert.equal(csrf.verify(token,{...csrfBinding,purpose:'login'}),false);
  assert.equal(csrf.verify(token,{...csrfBinding,identityBinding:{...binding,projectRef:'zzzzzzzzzzzzzzzzzzzz',issuer:'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/auth/v1'}}),false);
});
test('CP2 CSRF verification rejects malformed or noncanonical proofs without throwing',()=>{
  const csrf=createCsrfProtector(new Uint8Array(32).fill(80)),token=csrf.issue(csrfBinding);
  for(const value of ['', token+'=',token+'\n',token.slice(1),'v2.'+token.slice(3),'v1.'+'A'.repeat(43),'x'.repeat(50000)])assert.equal(csrf.verify(value,csrfBinding),false);
  assert.equal(csrf.verify(token,{...csrfBinding,handleHash:'not-a-hash'}),false);
});
test('CP2 CSRF mutation requires exact approved Origin and a server-derived limiter key',()=>{
  const csrf=createCsrfProtector(new Uint8Array(32).fill(80)),token=csrf.issue(csrfBinding),p=policy();
  csrf.assertMutation({origin:p.allowedOrigins[0],csrfToken:token,limiterKey:'server'},csrfBinding,p);
  for(const origin of [null,'null','https://primitives.hamdee.invalid/','https://primitives.hamdee.invalid.evil.invalid','http://primitives.hamdee.invalid'])assert.throws(()=>csrf.assertMutation({origin,csrfToken:token,limiterKey:'server'},csrfBinding,p),CsrfError);
  for(const csrfToken of [null,'wrong'])assert.throws(()=>csrf.assertMutation({origin:p.allowedOrigins[0],csrfToken,limiterKey:'server'},csrfBinding,p));
  assert.throws(()=>csrf.assertMutation({origin:p.allowedOrigins[0],csrfToken:token,limiterKey:''},csrfBinding,p));
});
test('CP2 CSRF construction has no default key or permissive malformed-policy path',()=>{
  for(const length of [0,16,31,33])assert.throws(()=>createCsrfProtector(new Uint8Array(length)),CsrfError);
  const csrf=createCsrfProtector(new Uint8Array(32));assert.throws(()=>csrf.assertMutation({origin:'https://primitives.hamdee.invalid',csrfToken:csrf.issue(csrfBinding),limiterKey:'server'},csrfBinding,{} as ReturnType<typeof policy>),CsrfError);
});
