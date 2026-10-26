import { randomUUID } from 'node:crypto';
import type { Identity,IdentityProvider } from './auth';
import { PropertyService, safeUnexpected } from './service';
import { ApiError, requireThat } from './errors';
import { uuid } from './validation';
import { securityLogger,logSafely,type SecurityLogger } from './security-log';
import { RentalService } from './rental';
import { ExpenseService } from './expenses';
import { PartnerService } from './partners';
import { DailyDashboardService } from './daily-dashboard';
const base='/api/hamdee/v1';
/** Trusted server compositions only. Each module keeps its financial validation,
 * transaction, audit and command replay inside the existing owner context. */
export interface OperationsApiService {
  overview(identity:Identity,query:{month:string;asOf:string;collectorId?:string;accountId?:string;vehicleId?:string;availabilityStart?:string;availabilityEnd?:string}):Promise<unknown>;
  receipts?(identity:Identity,query:{asOf:string;propertyId?:string;cursor?:string}):Promise<unknown>;
  mutate(identity:Identity,input:unknown,key:string,requestId:string):Promise<unknown>;
}
export interface OperationsApiServices {
  readonly staffCollections?:OperationsApiService;
  readonly companyFinance?:OperationsApiService;
  readonly carRentals?:OperationsApiService;
  readonly personalFinance?:OperationsApiService;
}
async function readJson(request:Request):Promise<unknown> {
  requireThat(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'JSON_REQUIRED','Submit JSON metadata.');
  const reader=request.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();throw new ApiError(413,'PAYLOAD_TOO_LARGE','The submission is too large.');}chunks.push(value);}}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'INVALID_JSON','Submit valid JSON metadata.');}
}
export function createHandler(provider:IdentityProvider,service:PropertyService,logger:SecurityLogger=securityLogger,operations:OperationsApiServices={}) {
  return async function handle(request:Request):Promise<Response> {
    const requestId=randomUUID();
    const headers:Record<string,string>={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId};
    const json=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json({...body as object,requestId},{status,headers:{...headers,...extra}});
    try {
      const identity=await provider.validate(request);
      const url=new URL(request.url),path=url.pathname.slice(base.length).replace(/\/$/,'');
      const moduleName=path.split('/')[1];
      const modules:Record<string,keyof OperationsApiServices>={'staff-collections':'staffCollections','company-finance':'companyFinance','personal-finance':'personalFinance','car-rentals':'carRentals'};
      // Also validate enabled membership before parsing untrusted mutation fields.
      // For operational modules, the full owner portfolio grant is checked in
      // this same transaction; it is never inferred from a role name alone.
      const session=await service.session(identity,Object.hasOwn(modules,moduleName)||moduleName==='partners'||moduleName==='operations-dashboard');
      requireThat(url.pathname===base||url.pathname.startsWith(base+'/'),404,'NOT_FOUND','Endpoint not found.');
      if(path==='/session'&&request.method==='GET') return json({data:{...session,authenticationProvider:provider.kind||'server-validated'}});
      if(moduleName==='operations-dashboard'){
        requireThat(path==='/operations-dashboard',404,'NOT_FOUND','Endpoint not found.');
        requireThat(request.method==='GET',405,'METHOD_NOT_ALLOWED','The daily operations dashboard is read-only.');
        requireThat([...url.searchParams.keys()].every(key=>['month','asOf'].includes(key)&&url.searchParams.getAll(key).length===1),400,'INVALID_QUERY','Choose valid daily dashboard dates.');
        const period=url.searchParams.get('month')??'',asOf=url.searchParams.get('asOf')??'';
        requireThat(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(period)&&/^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/.test(asOf)&&
          Number.isFinite(Date.parse(asOf))&&new Date(asOf).toISOString().slice(0,10)===asOf,400,'INVALID_QUERY','Choose valid daily dashboard dates.');
        return json({data:await new DailyDashboardService(service).overview(identity,{month:period,asOf})});
      }
      if(moduleName==='partners'){
        const partners=new PartnerService(service),isCommand=path==='/partners/commands';
        requireThat(path==='/partners'||isCommand,404,'NOT_FOUND','Endpoint not found.');
        requireThat(request.method===(isCommand?'POST':'GET'),405,'METHOD_NOT_ALLOWED','This method is unavailable.');
        if(!isCommand){
          const allowed=['month','asOf','propertyId','partnerId','recordedThrough','entryCursor','partnerCursor','limit'];
          requireThat([...url.searchParams.keys()].every(k=>allowed.includes(k)&&url.searchParams.getAll(k).length===1),400,'INVALID_QUERY','Check the partner statement filters.');
          const fields=Object.fromEntries(url.searchParams);
          const limit=Number(fields.limit??100);
          requireThat(Number.isInteger(limit)&&limit>=1&&limit<=100,400,'INVALID_QUERY','Choose a page size from 1 to 100.');
          requireThat(fields.month&&fields.asOf,400,'INVALID_QUERY','Choose a statement month and through date.');
          return json({data:await partners.overview(identity,{...fields,month:fields.month,asOf:fields.asOf,limit})});
        }
        requireThat([...url.searchParams.keys()].length===0,400,'INVALID_QUERY','Command requests do not accept query filters.');
        requireThat(request.headers.get('origin')===url.origin,403,'ORIGIN_REJECTED','This request origin is not permitted.');
        const key=request.headers.get('idempotency-key');requireThat(key&&uuid.test(key),400,'IDEMPOTENCY_KEY_REQUIRED','A valid operation key is required.');
        const result=await partners.mutate(identity,await readJson(request),key,requestId);
        return json(result,result.status,result.replay?{'Idempotent-Replay':'true'}:{});
      }
      if(Object.hasOwn(modules,moduleName)){
        const modulePath='/'+moduleName,isCommand=path===modulePath+'/commands',isReceipts=moduleName==='staff-collections'&&path===modulePath+'/receipts';
        requireThat(path===modulePath||isCommand||isReceipts,404,'NOT_FOUND','Endpoint not found.');
        // No staff identities or additional roles: these APIs require the same
        // current full owner portfolio grant before request fields are parsed.
        requireThat(request.method===(isCommand?'POST':'GET'),405,'METHOD_NOT_ALLOWED','This method is unavailable.');
        const module=operations[modules[moduleName]];
        if(!isCommand){
          const filter=isReceipts?'propertyId':moduleName==='staff-collections'?'collectorId':moduleName==='car-rentals'?'vehicleId':'accountId';
          const allowed=isReceipts?['asOf','propertyId','cursor']:['month','asOf',filter,...(moduleName==='car-rentals'?['availabilityStart','availabilityEnd']:[])];
          requireThat([...url.searchParams.keys()].every(k=>allowed.includes(k)&&url.searchParams.getAll(k).length===1),400,'INVALID_QUERY','Check the reporting filters.');
          const asOf=url.searchParams.get('asOf')??'',month=url.searchParams.get('month')??'',selected=filter?url.searchParams.get(filter):null;
          const cursor=isReceipts?url.searchParams.get('cursor'):null;
          const availability=moduleName==='car-rentals'?Object.fromEntries(['availabilityStart','availabilityEnd'].filter(k=>url.searchParams.has(k)).map(k=>[k,url.searchParams.get(k)!])):{};
          requireThat(/^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/.test(asOf)&&Number.isFinite(Date.parse(asOf))&&new Date(asOf).toISOString().slice(0,10)===asOf&&
            (isReceipts||/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(month))&&(selected===null||uuid.test(selected))&&
            (cursor===null||/^[A-Za-z0-9_-]{1,512}$/.test(cursor)),400,'INVALID_QUERY','Choose valid reporting dates and record filters.');
          requireThat(Object.values(availability).every(d=>/^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d)&&
            (!availability.availabilityEnd||availability.availabilityEnd>=(availability.availabilityStart??asOf)),400,'INVALID_QUERY','Choose an ordered availability date range.');
          requireThat(module,503,'CONFIGURATION_UNAVAILABLE','The requested operational module is unavailable.');
          if(isReceipts){
            requireThat(module.receipts,503,'CONFIGURATION_UNAVAILABLE','The requested operational module is unavailable.');
            return json({data:await module.receipts(identity,{asOf,...(selected?{propertyId:selected}:{}),...(cursor?{cursor}:{})})});
          }
          return json({data:await module.overview(identity,{month,asOf,...(selected&&filter?{[filter]:selected}:{}),...availability})});
        }
        requireThat([...url.searchParams.keys()].length===0,400,'INVALID_QUERY','Command requests do not accept query filters.');
        requireThat(request.headers.get('origin')===url.origin,403,'ORIGIN_REJECTED','This request origin is not permitted.');
        const key=request.headers.get('idempotency-key');requireThat(key&&uuid.test(key),400,'IDEMPOTENCY_KEY_REQUIRED','A valid operation key is required.');
        requireThat(module,503,'CONFIGURATION_UNAVAILABLE','The requested operational module is unavailable.');
        const result=await module.mutate(identity,await readJson(request),key,requestId);
        requireThat(result&&typeof result==='object'&&!Array.isArray(result)&&'data' in result&&'replay' in result&&typeof result.replay==='boolean',503,'CONFIGURATION_UNAVAILABLE','The requested operational module is unavailable.');
        return json(result,200,result.replay?{'Idempotent-Replay':'true'}:{});
      }
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
        const revision=request.headers.get('x-hamdee-property-revision'),legacy=request.headers.get('if-match');
        requireThat(!(revision!==null&&legacy!==null),400,'AMBIGUOUS_REVISION','Submit one property revision header.');
        // Standard conditional headers can be evaluated by an intermediary
        // against the NEW response ETag after the mutation has committed.
        // Legacy If-Match remains only for existing injected HTTP loopback tests;
        // the deployable owner composition requires an exact HTTPS origin.
        const loopback=url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
        const match=(revision??(loopback?legacy:null))?.match(/^"property:([^:]+):(\d+)"$/);
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
