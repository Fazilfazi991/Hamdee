// Explicit opt-in orchestration. Every suite creates, verifies and stops its
// own fresh loopback cluster; no existing service or generic DB URL is used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {fileURLToPath,URL} from 'node:url';
import {inspectOwnerPortableRuntime} from '../tests/support/owner-crm-harness.ts';

assert.ok(process.argv.includes('--approved-local-only'),'Explicit local setup authorization required');
const root=fileURLToPath(new URL('../',import.meta.url));
const supplied=process.argv.find(value=>value.startsWith('--runtime-root='))?.slice('--runtime-root='.length);
const tools=path.resolve(supplied||path.join(root,'.test-tools'));
await inspectOwnerPortableRuntime(path.join(tools,'postgresql-17.11-5-windows-x64-binaries.zip'),path.join(tools,'postgresql-17.11-5'));
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(PG|HAMDEE_|SUPABASE_|DATABASE_URL$)/i.test(key)));
for(const suite of ['legacy','owner','car-finance','continuation']){
 const args=suite==='legacy'||suite==='owner'
  ?['--import','tsx',path.join(root,'scripts/run-native.mjs'),'--suite='+suite,'--approved-local-only','--runtime-root='+tools]
  :['--import','tsx','--test','--test-concurrency=1','--test-timeout=120000',path.join(root,'tests/native',suite==='car-finance'?'car-finance-qa.postgres.test.ts':'client-continuation.postgres.test.ts')];
 console.log('NATIVE_SUITE_BEGIN '+suite);
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,shell:false,stdio:'inherit',env:{...clean,HAMDEE_NATIVE_RUNTIME_ROOT:tools}});child.once('error',reject);child.once('close',resolve);});
 console.log('NATIVE_SUITE_END '+JSON.stringify({suite,exitCode:code}));
 if(code!==0){process.exitCode=1;break;}
}
