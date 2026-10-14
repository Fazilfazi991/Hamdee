// Reproducible local QA launcher; no bundled binaries. Never a deployable
// auth switch. Each invocation creates/stops its OWN fresh local cluster.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access,readFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectOwnerPortableRuntime, startOwnerNativeCluster,verifyOwnerRestartWitness } from '../tests/support/owner-crm-harness.ts';
const suite=process.argv.find(value=>value.startsWith('--suite='))?.slice(8);
assert.ok(suite==='legacy'||suite==='owner','Choose --suite=legacy or --suite=owner explicitly');
assert.ok(process.argv.includes('--approved-local-only'),'Explicit local setup authorization required');
const root=fileURLToPath(new URL('../',import.meta.url));
const test=new URL(suite==='legacy'?'../tests/native/postgres.test.ts':'../tests/native/owner-persistence.test.ts',import.meta.url);
await access(test);
const suppliedRoot=process.argv.find(value=>value.startsWith('--runtime-root='))?.slice('--runtime-root='.length);
const tools=path.resolve(suppliedRoot||path.join(root,'.test-tools'));
const runtime=await inspectOwnerPortableRuntime(path.join(tools,'postgresql-17.11-5-windows-x64-binaries.zip'),path.join(tools,'postgresql-17.11-5'));
const cluster=await startOwnerNativeCluster(runtime,suite);
const witnessFile=path.join(cluster.evidence().dataDirectory,'owner-witness.private.json');
try{
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(PG|HAMDEE_|SUPABASE_|DATABASE_URL$)/i.test(key)));
  const env=suite==='legacy'?{...clean,HAMDEE_NATIVE_TEST_URL:cluster.connection,HAMDEE_NATIVE_TEST_CONFIRM:'disposable-local-hamdee'}:
    {...clean,HAMDEE_OWNER_NATIVE_TEST_URL:cluster.connection,HAMDEE_OWNER_NATIVE_TEST_CONFIRM:'disposable-local-hamdee-owner',HAMDEE_OWNER_NATIVE_WITNESS_FILE:witnessFile};
  let durableWitness;
  const exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs',import.meta.url)),
      '--test','--test-concurrency=1','--test-timeout=60000',fileURLToPath(test)],
      {cwd:root,env,windowsHide:true,shell:false,stdio:suite==='owner'?['ignore','pipe','pipe','ipc']:'inherit'});
    if(suite==='owner'){
      child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));
      child.on('message',value=>{if(value?.type==='owner-qa-durable-witness')durableWitness=value;});
    }
    child.once('error',()=>reject(new Error('Owned native QA test child could not start')));child.once('close',resolve);
  });
  process.exitCode=exitCode===0?0:1;
  if(suite==='owner'&&exitCode===0){
    durableWitness=JSON.parse(await readFile(witnessFile,'utf8'));await unlink(witnessFile);
    assert.ok(durableWitness,'Native suite must provide private restart witness');
    const priorPid=cluster.evidence().ownedPid;await cluster.restart();assert.notEqual(cluster.evidence().ownedPid,priorPid);
    const result=await verifyOwnerRestartWitness(durableWitness.backendConnection,durableWitness.witness);
    console.log('OWNER_ENGINE_AND_APP_RESTART_PASS',JSON.stringify({...result,priorEnginePid:priorPid,newEnginePid:cluster.evidence().ownedPid}));
  }
}finally{
  await unlink(witnessFile).catch(()=>{});
  await cluster.close();console.log('Owned local native QA evidence:',JSON.stringify(cluster.evidence()));
}
