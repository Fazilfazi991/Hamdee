import { randomUUID } from 'node:crypto';
import type { IdentityProvider } from './auth';
import { PropertyService, safeUnexpected } from './service';
import { ApiError, requireThat } from './errors';
import { uuid } from './validation';
import { securityLogger,logSafely,type SecurityLogger } from './security-log';
import { RentalService } from './rental';
import { ExpenseService } from './expenses';
const base='/api/hamdee/v1';
async function readJson(request:Request):Promise<unknown> {
  requireThat(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'JSON_REQUIRED','Submit JSON metadata.');
  const reader=request.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();throw new ApiError(413,'PAYLOAD_TOO_LARGE','The submission is too large.');}chunks.push(value);}}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'INVALID_JSON','Submit valid JSON metadata.');}
}
export function createHandler(provider:IdentityProvider,service:PropertyService,logger:SecurityLogger=securityLogger) {
  return async function handle(request:Request):Promise<Response> {
    const requestId=randomUUID();
    const headers:Record<string,string>={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId};
    const json=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json({...body as object,requestId},{status,headers:{...headers,...extra}});
    try {
      const identity=await provider.validate(request);
      // Also validate enabled membership before parsing untrusted mutation fields.
      const session=await service.session(identity);
      const url=new URL(request.url);
      requireThat(url.pathname===base||url.pathname.startsWith(base+'/'),404,'NOT_FOUND','Endpoint not found.');
      const path=url.pathname.slice(base.length).replace(/\/$/,'');
      if(path==='/session'&&request.method==='GET') return json({data:{...session,authenticationProvider:provider.kind||'server-validated'}});
      if(path==='/rental'||path==='/expenses'){
        const rental=path==='/rental'?new RentalService(service):new ExpenseService(service);
        if(request.method==='GET'){
          requireThat([...url.searchParams.keys()].every(k=>['month','asOf','propertyId'].includes(k)&&url.searchParams.getAll(k).length===1),400,'INVALID_QUERY','Check rental filters.');
          const today=new Date().toISOString().slice(0,10);
          return json({data:await rental.overview(identity,{month:url.searchParams.get('month')??today.slice(0,7),asOf:url.searchParams.get('asOf')??today,propertyId:url.searchParams.get('propertyId')??undefined})});
        }
        requireThat(request.method==='POST',405,'METHOD_NOT_ALLOWED','This method is unavailable.');
        requireThat(request.headers.get('origin')===url.origin,403,'ORIGIN_REJECTED','This request origin is not permitted.');
        const key=request.headers.get('idempotency-key');requireThat(key&&uuid.test(key),400,'IDEMPOTENCY_KEY_REQUIRED','A valid operation key is required.');
        const result=await rental.mutate(identity,await readJson(request),key,requestId);
        return json(result,200,result.replay?{'Idempotent-Replay':'true'}:{});
      }
      if(path==='/dashboard'&&request.method==='GET'){
        requireThat([...url.searchParams.keys()].length===0,400,'INVALID_QUERY','Check the dashboard request.');
        return json({data:await service.dashboard(identity)});
      }
      const parts=path.split('/').filter(Boolean);
      requireThat(parts[0]==='properties'&&parts.length<=3,404,'NOT_FOUND','Endpoint not found.');
      const id=parts[1];
      if(id) requireThat(uuid.test(id),404,'NOT_FOUND','Property not found.');
      if(request.method==='GET') {
        const isAudit=parts[2]==='audit';
        const allowed=isAudit?['limit','cursor']:['limit','cursor','archiveState','q'];
        requireThat([...url.searchParams.keys()].every(k=>allowed.includes(k)&&url.searchParams.getAll(k).length===1),400,'INVALID_QUERY','Check the list filters.');
        const limit=Number(url.searchParams.get('limit')||50),cursor=url.searchParams.get('cursor')||null;
        requireThat(Number.isInteger(limit)&&limit>=1&&limit<=100,400,'INVALID_QUERY','Choose a valid page size.');
        if(isAudit) {
          requireThat(id && (!cursor || (/^\d+$/.test(cursor)&&Number.isSafeInteger(Number(cursor))&&Number(cursor)<=2147483647)),400,'INVALID_QUERY','Check the history cursor.');
          return json(await service.audit(identity,id,limit,Number(cursor||0)));
        }
        requireThat(!parts[2],404,'NOT_FOUND','Endpoint not found.');
        if(id) {const data=await service.get(identity,id);return json({data},200,{ETag:`"property:${id}:${data.version}"`});}
        const archiveState=url.searchParams.get('archiveState')||'active',q=url.searchParams.get('q')||'';
        requireThat(['active','archived','all'].includes(archiveState)&&q.length<=200&&(!cursor||uuid.test(cursor)),400,'INVALID_QUERY','Check the list filters.');
        return json(await service.list(identity,{archiveState,q,limit,cursor}));
      }
      const action=request.method==='POST'&&!id?'create':request.method==='PATCH'&&id&&!parts[2]?'update':
        request.method==='POST'&&id&&['archive','restore'].includes(parts[2])?parts[2] as 'archive'|'restore':null;
      requireThat(action,405,'METHOD_NOT_ALLOWED','This method is unavailable.');
      // Cookie-based providers must additionally enforce CSRF in their adapter.
      // Current client uses bearer identities; reject cross-origin browser writes.
      requireThat(request.headers.get('origin')===url.origin,403,'ORIGIN_REJECTED','This request origin is not permitted.');
      const key=request.headers.get('idempotency-key');
      requireThat(key&&uuid.test(key),400,'IDEMPOTENCY_KEY_REQUIRED','A valid operation key is required.');
      let expected:number|undefined;
      if(id){
        const match=request.headers.get('if-match')?.match(/^"property:([^:]+):(\d+)"$/);
        requireThat(match&&match[1]===id&&Number.isSafeInteger(Number(match[2]))&&Number(match[2])>0,428,'PRECONDITION_REQUIRED','A current property revision is required.');expected=Number(match[2]);
      }
      const body=await readJson(request);
      const result=await service.mutate(identity,{action,id,key,expected,body,requestId});
      return json({data:result.data},result.status,{ETag:`"property:${result.data.id}:${result.data.version}"`,
        ...(action==='create'?{Location:`${base}/properties/${result.data.id}`}:{ }),...(result.replay?{'Idempotent-Replay':'true'}:{})});
    }catch(error){const safe=safeUnexpected(error);
      if([401,403,503].includes(safe.status))logSafely(logger,{event:safe.status===401?'authentication_rejected':safe.status===403?'authorization_rejected':'operation_unavailable',requestId,status:safe.status});
      return json({error:{code:safe.code,message:safe.message}},safe.status);}
  };
}
// Hard fail closed in the deployable entry point. No environment test-auth switch.
export async function unavailable():Promise<Response> {
  const requestId=randomUUID();
  return Response.json({error:{code:'CONFIGURATION_UNAVAILABLE',message:'The dedicated HAMDEE backend and identity provider are not configured.'},requestId},
    {status:503,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId}});
}
