// Synthetic reference regression only. No application or hosted financial writes.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
for(const args of [
  ['tests/financial/model.test.cjs'],
  ['--test','tests/financial/production-baseline.test.cjs','tests/financial/agent4-financial.test.cjs','tests/financial/agent4-reports.test.cjs']
]){
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd,windowsHide:true,shell:false,stdio:'inherit'});
    child.once('error',reject);child.once('close',resolve);
  });
  if(code!==0){process.exitCode=1;break;}
}
