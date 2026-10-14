import { Pool, type PoolClient } from 'pg';
import { requireThat } from './errors';
import { securityLogger, logSafely, type SecurityLogger } from './security-log';
export interface Sql { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }
export interface Database { transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> }

export function localConnectionOptions(connectionUrl:string) {
  let url:URL;try{url=new URL(connectionUrl);}catch{throw new Error('A dedicated local HAMDEE database is required.');}
  requireThat(['postgres:','postgresql:'].includes(url.protocol) && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) &&
    /^\/hamdee_dev_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash && url.username && url.password && url.port,
    503,'ENVIRONMENT_MISMATCH','A dedicated local HAMDEE database is required.');
  // Explicit fields prevent query-string overrides, PG* defaults and pgpass lookup.
  return {host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port),database:url.pathname.slice(1),
    user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),ssl:false,
    options:'-c search_path=pg_catalog',client_encoding:'UTF8',max:4,connectionTimeoutMillis:3000,
    statement_timeout:10000,idle_in_transaction_session_timeout:10000,application_name:'hamdee-property-foundation'};
}

// Shared with fault-injection unit tests; mocks do not establish native integration.
export async function runTransaction<T>(client:Pick<PoolClient,'query'|'release'|'on'|'removeListener'>,work:(sql:Sql)=>Promise<T>):Promise<T> {
  let destroy=false,connectionFailed=false;
  const onError=()=>{connectionFailed=true;};client.on?.('error',onError);
  try{
    await client.query('BEGIN');
    const result=await work({query:async <R>(sql:string,params?:unknown[])=>{if(connectionFailed)throw new Error('Database connection unavailable');return {rows:(await client.query(sql,params)).rows as R[]};}});
    if(connectionFailed)throw new Error('Database connection unavailable');
    await client.query('COMMIT');return result;
  }catch(error){
    destroy=true;
    try{await client.query('ROLLBACK');}catch{/* Discard broken connection; preserve original failure. */}
    throw error;
  }finally{client.release(destroy);client.removeListener?.('error',onError);}
}

// Does not connect or load environment variables. Only explicitly passed,
// dedicated local connection pools may be adapted in TASK 004.
export class LocalPostgresDatabase implements Database {
  private pool:Pool;
  constructor(connectionUrl: string,logger:SecurityLogger=securityLogger) {
    this.pool=new Pool(localConnectionOptions(connectionUrl));
    this.pool.on('error',()=>logSafely(logger,{event:'database_connection_error',status:503}));
  }
  async close(){await this.pool.end();}
  async transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    return runTransaction(client,work);
  }
}
