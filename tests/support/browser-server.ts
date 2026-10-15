import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture';
import { unavailable } from '../../src/http';
// Started/stopped only by the automated Playwright suite. No standalone script,
// public auth endpoint or deployable test identity configuration exists.
export async function startHarness(configured=true) {
  const f=await fixture();
  const root=new URL('../../public/',import.meta.url);
  const files=['workspace/index.html','workspace/app.js', 'workspace/rental.js', 'workspace/expenses.js','workspace/adapter.js','workspace/foundation.css','shared/styles.css','shared/icons.js','shared/hamdee-logo.png','shared/inter-latin.woff2'];
  const server=createServer(async(req,res)=>{
    try{
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const pathname=new URL(req.url||'/',origin).pathname;
      if(pathname.startsWith('/api/hamdee/v1')){
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        const request=new Request(origin+req.url,{method:req.method,headers:new Headers(req.headers as Record<string,string>),...(chunks.length?{body:Buffer.concat(chunks)}:{})});
        const response=configured?await f.handle(request):await unavailable();
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
      }
      const file=pathname.slice(1);if(!files.includes(file)){res.writeHead(404).end();return;}
      const mime=file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'font/woff2';
      res.writeHead(200,{'Content-Type':mime});res.end(await readFile(new URL(file,root)));
    }catch{res.writeHead(500).end('Automated test harness failure');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {f,url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,close:async()=>{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});await f.pg.close();}};
}
