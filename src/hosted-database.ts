import { Pool, type PoolConfig } from 'pg';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { type Database, type Sql, runTransaction } from './database';
import { ApiError, requireThat } from './errors';
import { logSafely, securityLogger, type SecurityLogger } from './security-log';

// This branch is deliberately unable to open the client-records database.
export const HAMDEE_DEVELOPMENT_PROJECT='jfynuafwsympxxpkqags';
export const HAMDEE_PRODUCTION_PROJECT='dytlzfwbgeuhzgzemqsf';
export const HAMDEE_DEMO_BRANCH='codex/hamdee-demo-preview';
export const HAMDEE_DEMO_ORIGIN='https://hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app';
export function isApprovedDemoRuntime(environment:Readonly<Record<string,string|undefined>>=process.env):boolean {
  return environment.VERCEL_ENV==='preview'&&environment.VERCEL_GIT_COMMIT_REF===HAMDEE_DEMO_BRANCH&&
    environment.HAMDEE_OWNER_ORIGIN===HAMDEE_DEMO_ORIGIN;
}
export interface HostedDatabasePins {
  readonly projectRef:typeof HAMDEE_DEVELOPMENT_PROJECT;
  readonly host:string;
  readonly port:5432|6543;
  readonly database:'postgres';
  readonly user:string;
  readonly mode:'direct'|'transaction';
}
// Pins reviewed from the dedicated project Connect panel; activation remains separately gated.
// A URL, region-derived hostname or environment variable cannot approve itself.
export const reviewedHostedDatabasePins:HostedDatabasePins|null=Object.freeze({"projectRef":"jfynuafwsympxxpkqags","host":"aws-0-ap-southeast-1.pooler.supabase.com","port":6543,"database":"postgres","user":"hamdee_backend.jfynuafwsympxxpkqags","mode":"transaction"});
const denied=():never=>{throw new ApiError(503,'ENVIRONMENT_MISMATCH','The dedicated HAMDEE development database is unavailable.');};
type HostedConfigurationStage='process_environment'|'pins'|'url'|'password_encoding'|'tls_ca'|'driver_constructor';
const reportedConfigurationFailures=new Set<HostedConfigurationStage>();
function reportConfigurationFailure(stage:HostedConfigurationStage):void {
  if(!reportedConfigurationFailures.has(stage)){
    reportedConfigurationFailures.add(stage);
    try{console.warn(JSON.stringify({event:'hosted_database_configuration_unavailable',stage}));}catch{/* Diagnostics cannot alter fail-closed behavior. */}
  }
}

/** Offline preparation: no DNS, socket, environment defaults or credential logging. */
export function hostedConnectionOptions(connectionUrl:string,pins:HostedDatabasePins|null,ca?:string):PoolConfig {
  let stage:HostedConfigurationStage='process_environment';
  try{
    requireThat(isApprovedDemoRuntime()&&!Object.entries(process.env).some(([key,value])=>/^PG/i.test(key)&&!!value)&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0',
      503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    stage='pins';
    requireThat(pins?.projectRef===HAMDEE_DEVELOPMENT_PROJECT&&pins.projectRef!==String(HAMDEE_PRODUCTION_PROJECT)&&
      reviewedHostedDatabasePins!==null&&pins.host===reviewedHostedDatabasePins.host&&pins.port===reviewedHostedDatabasePins.port&&
      pins.user===reviewedHostedDatabasePins.user&&pins.mode===reviewedHostedDatabasePins.mode,
      503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    const direct=pins.mode==='direct';
    requireThat(pins.database==='postgres'&&(direct
      ?pins.host===`db.${HAMDEE_DEVELOPMENT_PROJECT}.supabase.co`&&pins.port===5432&&pins.user==='hamdee_backend'
      :pins.mode==='transaction'&&/^[a-z0-9]+(?:-[a-z0-9]+)*\.pooler\.supabase\.com$/.test(pins.host)&&pins.port===6543&&pins.user===`hamdee_backend.${HAMDEE_DEVELOPMENT_PROJECT}`),
      503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    stage='url';
    const url=new URL(connectionUrl);
    requireThat(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname===pins.host&&Number(url.port)===pins.port&&
      url.pathname==='/'+pins.database&&decodeURIComponent(url.username)===pins.user&&!!url.password&&!url.search&&!url.hash,
      503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    stage='password_encoding';
    const password=decodeURIComponent(url.password);
    requireThat(password.length>0&&!password.includes('\0'),503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    // Direct endpoints require the project's reviewed CA. Poolers may use the
    // Node trust store; an explicitly supplied CA is parsed, never ignored.
    stage='tls_ca';
    requireThat(!direct||!!ca,503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');
    if(ca){const certificate=new X509Certificate(ca);requireThat(certificate.ca,503,'ENVIRONMENT_MISMATCH','Dedicated database review is required.');}
    return {host:pins.host,port:pins.port,database:pins.database,user:pins.user,password,
      ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:pins.host,checkServerIdentity,...(ca?{ca}:{})},
      max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,allowExitOnIdle:true,
      application_name:'hamdee-isolated-demo'};
  }catch{reportConfigurationFailure(stage);return denied() as never;}
}

/** All session state is transaction-local, including on transaction poolers.
 * Existing queries use unnamed statements and no query pipelining. */
export async function guardHostedTransaction<T>(sql:Sql,work:(sql:Sql)=>Promise<T>):Promise<T> {
  requireThat(isApprovedDemoRuntime(),503,'ENVIRONMENT_MISMATCH','The dedicated HAMDEE development database is unavailable.');
  // All four independent settings remain transaction-local. One server round
  // trip applies the same fixed limits before any role/identity/data query.
  await sql.query(`SELECT pg_catalog.set_config('statement_timeout','10000ms',true),
    pg_catalog.set_config('lock_timeout','3000ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout','10000ms',true),
    pg_catalog.set_config('search_path','pg_catalog',true)`);
  const role=(await sql.query<{safe:boolean}>(`SELECT r.rolname='hamdee_backend' AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolinherit)
    AND NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname NOT IN ('hamdee_backend','hamdee_runtime')
      AND pg_has_role(session_user,other.oid,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
      WHERE member.rolname=session_user AND m.admin_option)
    AND NOT EXISTS(SELECT 1 FROM pg_roles runtime WHERE runtime.rolname='hamdee_runtime'
      AND (runtime.rolsuper OR runtime.rolbypassrls OR runtime.rolcanlogin OR runtime.rolcreatedb OR runtime.rolcreaterole OR runtime.rolreplication))
    AS safe FROM pg_roles r WHERE r.rolname=session_user`)).rows[0];
  requireThat(role?.safe===true,503,'ENVIRONMENT_MISMATCH','The dedicated HAMDEE development database is unavailable.');
  await sql.query('SET LOCAL ROLE hamdee_runtime');
  const marker=(await sql.query<{app_id:string;environment:string;project_ref:string;data_class:string}>(
    'SELECT app_id,environment,project_ref,data_class FROM hamdee_private.application_identity')).rows;
  requireThat(marker.length===1&&marker[0].app_id==='hamdee'&&marker[0].environment==='synthetic-development'&&
    marker[0].project_ref===HAMDEE_DEVELOPMENT_PROJECT&&marker[0].data_class==='synthetic_only',
    503,'ENVIRONMENT_MISMATCH','The dedicated HAMDEE development database is unavailable.');
  return work(sql);
}

export class HostedPostgresDatabase implements Database {
  private readonly pool:Pool;
  constructor(connectionUrl:string,pins:HostedDatabasePins|null,ca?:string,logger:SecurityLogger=securityLogger){
    const options=hostedConnectionOptions(connectionUrl,pins,ca);
    this.pool=(()=>{
      try{
        const pool=new Pool(options);
        pool.on('error',()=>logSafely(logger,{event:'database_connection_error',status:503}));
        return pool;
      }catch{reportConfigurationFailure('driver_constructor');return denied();}
    })();
  }
  async close(){await this.pool.end();}
  async transaction<T>(work:(sql:Sql)=>Promise<T>):Promise<T>{
    return runTransaction(await this.pool.connect(),sql=>guardHostedTransaction(sql,work));
  }
}
