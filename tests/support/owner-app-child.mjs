// Reproducible test-support process only. Never imported by app/runtime/routes.
import { fileURLToPath } from 'node:url';
import { LocalPostgresDatabase } from '../../src/database.ts';
import { ownerNativeConnection, startOwnerLoopbackHarness, createOwnerQaFixture } from './owner-crm-harness.ts';
let server,database,fixture,stopping=false;
process.on('message',async message=>{
  if(message.type==='start')try{
    ownerNativeConnection(message.connection,'disposable-local-hamdee-owner');
    database=new LocalPostgresDatabase(message.connection,()=>{});
    server=await startOwnerLoopbackHarness(fileURLToPath(new URL('../../public/',import.meta.url)),async origin=>{
      fixture=await createOwnerQaFixture({origin,database});
      return request=>new URL(request.url).pathname.startsWith('/api/hamdee/auth/')?fixture.app().handleAuth(request):fixture.app().handleProperties(request);
    },message.preferredPort);
    process.send?.({type:'ready',url:server.url,pid:process.pid});
  }catch{
    await server?.close();await database?.close();process.send?.({type:'failed'});process.disconnect();
  }
  if(message.type==='stop'&&!stopping){stopping=true;await server?.close();await fixture?.close();await database?.close();process.disconnect();}
});
