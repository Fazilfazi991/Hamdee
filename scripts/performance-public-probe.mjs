// Public, unauthenticated timing only. Never reads credentials or logs responses/cookies.
import {performance} from 'node:perf_hooks';
const origin='https://hamdee.vercel.app';
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const results=[];
for(const path of ['/login','/api/hamdee/auth/state']){
  const samples=[];
  for(let i=0;i<8;i++){
    const start=performance.now();
    const response=await fetch(origin+path,{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(20000)});
    const ttfb=performance.now()-start;
    await response.arrayBuffer();
    samples.push({status:response.status,ttfbMs:Math.round(ttfb),totalMs:Math.round(performance.now()-start)});
  }
  const warm=samples.slice(1).map(x=>x.totalMs);
  results.push({path,firstObserved:samples[0],subsequent:{n:warm.length,p50Ms:percentile(warm,.5),p75Ms:percentile(warm,.75),p95Ms:percentile(warm,.95)},samples});
}
console.log(JSON.stringify({at:new Date().toISOString(),scope:'Unauthenticated public HTTPS only; first observed is not proven cold; subsequent requests are not authenticated workflow timings. Unthrottled host network, geographic RTT uncontrolled.',results},null,2));
