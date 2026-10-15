import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from './database';
import type { Identity } from './auth';
import { recheckIdentity } from './auth';
import { ApiError, requireThat } from './errors';
import { permits, type Grant, type Capability } from './permissions';
import { metadata, archiveReason } from './validation';

interface User { id: string; display_name: string; enabled: boolean }
type Row = Record<string, unknown>;
interface Context { sql: Sql; user: User; grants: Grant[] }
export interface Command { action: 'create'|'update'|'archive'|'restore'; id?: string; key: string; expected?: number; body: unknown; requestId: string }
export interface CommandResult { data: Row; status: number; replay: boolean }
export interface PropertyDashboard {
  readonly totalProperties:number;
  readonly activeProperties:number;
  readonly archivedProperties:number;
  readonly recentProperties:readonly Row[];
}
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : v;
function profile(row: Row): Row {
  return { id:row.id, name:row.name, location:row.location, counterpartyId:row.counterparty_id,
    lifecycleStatus:row.lifecycle_status, version:row.version, createdAt:iso(row.created_at), updatedAt:iso(row.updated_at),
    createdBy:row.created_by, updatedBy:row.updated_by, archivedAt:iso(row.archived_at), archivedBy:row.archived_by, archiveReason:row.archive_reason };
}
function canonical(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
}
export class PropertyService {
  constructor(private db: Database,private readonly owner?:Identity,private readonly databaseEnvironment:'local-test'|'synthetic-development'='local-test') {}
  async ownerContext<T>(identity:Identity,work:(sql:Sql,actorId:string)=>Promise<T>):Promise<T> {
    return this.context(identity,'read',async ctx=>{
      requireThat(ctx.grants.some(g=>g.role==='admin'&&g.portfolio),403,'OWNER_ACCESS_DENIED','Owner access is required.');
      return work(ctx.sql,ctx.user.id);
    });
  }
  async dashboard(identity:Identity):Promise<PropertyDashboard> {
    return this.context(identity,'read',async ctx=>{
      const counts=(await ctx.sql.query<{total:number;active:number;archived:number}>(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE lifecycle_status='registered')::int AS active,
        count(*) FILTER (WHERE lifecycle_status='archived')::int AS archived FROM hamdee_private.properties`)).rows[0];
      const recent=(await ctx.sql.query<Row>('SELECT * FROM hamdee_private.properties ORDER BY updated_at DESC,id DESC LIMIT 10')).rows;
      return {totalProperties:counts.total,activeProperties:counts.active,archivedProperties:counts.archived,recentProperties:recent.map(profile)};
    });
  }
  private async context<T>(identity: Identity, action: string, work: (ctx: Context)=>Promise<T>): Promise<T> {
    if(this.owner)requireThat(identity.issuer===this.owner.issuer&&identity.subject===this.owner.subject,403,'OWNER_ACCESS_DENIED','This account cannot access this CRM.');
    return this.db.transaction(async sql => {
      await sql.query('SET LOCAL ROLE hamdee_runtime');
      const marker = (await sql.query<{app_id:string;environment:string}>('SELECT app_id,environment FROM hamdee_private.application_identity')).rows[0];
      requireThat(marker?.app_id==='hamdee' && marker.environment===this.databaseEnvironment,503,'ENVIRONMENT_MISMATCH','The dedicated HAMDEE database is unavailable.');
      const user = (await sql.query<User>('SELECT id,display_name,enabled FROM hamdee_private.app_users WHERE issuer=$1 AND subject=$2',[identity.issuer,identity.subject])).rows[0];
      requireThat(user?.enabled,401,'UNAUTHENTICATED','Sign in with an authorized account.');
      await sql.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action',$2,true),set_config('hamdee.new_property','',true)",[user.id,action]);
      const grants=(await sql.query<Grant>('SELECT id,role,portfolio FROM hamdee_private.role_assignments WHERE user_id=$1 AND revoked_at IS NULL ORDER BY id',[user.id])).rows;
      if(this.owner)requireThat(grants.some(g=>g.role==='admin'&&g.portfolio),403,'FORBIDDEN','The owner portfolio grant is unavailable.');
      const result=await work({sql,user,grants});
      if(this.owner){
        const fresh=(await sql.query<{enabled:boolean;portfolio:boolean}>(`SELECT u.enabled,EXISTS(SELECT 1 FROM hamdee_private.role_assignments a
          WHERE a.user_id=u.id AND a.role='admin' AND a.portfolio AND a.revoked_at IS NULL) AS portfolio
          FROM hamdee_private.app_users u WHERE u.id=$1 AND u.issuer=$2 AND u.subject=$3`,[user.id,identity.issuer,identity.subject])).rows[0];
        requireThat(fresh?.enabled,401,'UNAUTHENTICATED','Sign in with an authorized account.');
        requireThat(fresh.portfolio,403,'FORBIDDEN','The owner portfolio grant is unavailable.');
      }
      // A late managed-session rejection aborts this transaction, including
      // metadata/history/idempotency writes, rather than reporting stale success.
      await recheckIdentity(identity);return result;
    });
  }
  async session(identity: Identity) {
    return this.context(identity,'read',async ({user,grants})=>({ id:user.id,name:user.display_name,
      roles:[...new Set(grants.map(g=>g.role))], capabilities:[...new Set(grants.flatMap(g=>(['read','create','update','archive','restore','audit'] as Capability[]).filter(c=>permits(g,c))))] }));
  }
  private async getRow(ctx:Context,id:string):Promise<Row> {
    const row=(await ctx.sql.query<Row>('SELECT * FROM hamdee_private.properties WHERE id=$1',[id])).rows[0];
    requireThat(row,404,'NOT_FOUND','Property not found.'); return row;
  }
  private async authorize(ctx:Context,id:string,action:Capability) {
    const allowed=(await ctx.sql.query<{allowed:boolean}>('SELECT hamdee_private.can_access($1,$2) AS allowed',[id,action])).rows[0]?.allowed;
    requireThat(allowed,403,'FORBIDDEN','This operation is not permitted.');
  }
  async get(identity:Identity,id:string) { return this.context(identity,'read',async ctx=>profile(await this.getRow(ctx,id))); }
  async list(identity:Identity,query:{archiveState:string;q:string;limit:number;cursor:string|null}) {
    return this.context(identity,'read',async ctx=>{
      const rows=(await ctx.sql.query<Row>(`SELECT * FROM hamdee_private.properties
        WHERE ($1='all' OR lifecycle_status=CASE WHEN $1='active' THEN 'registered' ELSE 'archived' END)
        AND ($2='' OR name ILIKE '%' || $2 || '%' OR coalesce(location,'') ILIKE '%' || $2 || '%')
        AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4`,[query.archiveState,query.q,query.cursor,query.limit+1])).rows;
      return {data:rows.slice(0,query.limit).map(profile),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null};
    });
  }
  async audit(identity:Identity,id:string,limit:number,cursor:number) {
    return this.context(identity,'audit',async ctx=>{
      await this.getRow(ctx,id); await this.authorize(ctx,id,'audit');
      const rows=(await ctx.sql.query<Row>(`SELECT id,property_id,version,actor_id,action,reason,changed_fields,request_id,occurred_at
        FROM hamdee_private.audit_events WHERE property_id=$1 AND version>$2 ORDER BY version LIMIT $3`,[id,cursor,limit+1])).rows;
      return {data:rows.slice(0,limit).map(r=>({id:r.id,propertyId:r.property_id,version:r.version,actorId:r.actor_id,action:r.action,reason:r.reason,changedFields:r.changed_fields,requestId:r.request_id,occurredAt:iso(r.occurred_at)})),
        nextCursor:rows.length>limit?rows[limit-1].version:null};
    });
  }
  async mutate(identity:Identity,command:Command):Promise<CommandResult> {
    const {action,id,key,expected,requestId}=command;
    // Validate before storing any command result; raw payloads are never logged.
    const values=action==='create'||action==='update'?metadata(command.body,action==='create'):null;
    const reason=values?null:archiveReason(command.body);
    const normalized=values||{reason};
    const digest=createHash('sha256').update(canonical({action,id:id||null,expected:expected??null,body:JSON.parse(canonical(normalized)),api:1})).digest('hex');
    return this.context(identity,action,async ctx=>{
      let old:Row|undefined;
      const createGrant=ctx.grants.find(g=>permits(g,'create') && (g.portfolio || g.role==='operations'));
      if(action==='create') requireThat(createGrant,403,'FORBIDDEN','This operation is not permitted.');
      else { old=await this.getRow(ctx,id!); await this.authorize(ctx,id!,action); }
      if(id){await ctx.sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['property:'+id]);old=await this.getRow(ctx,id);}
      // Database-scoped lock, not a process-local mutex: retry safety across servers.
      await ctx.sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.user.id}:${action}:${id||'new'}:${key}`]);
      const saved=(await ctx.sql.query<{digest:string;property_id:string;result:CommandResult}>(`SELECT digest,property_id,result FROM hamdee_private.commands
        WHERE actor_id=$1 AND operation=$2 AND target=$3 AND key=$4`,[ctx.user.id,action,id||'new',key])).rows[0];
      if(saved){
        requireThat(saved.digest===digest,409,'IDEMPOTENCY_KEY_REUSED','Use a new operation key for a changed submission.');
        await this.getRow(ctx,saved.property_id); await this.authorize(ctx,saved.property_id,action==='create'?'read':action);
        return {...saved.result,replay:true};
      }
      if(old) {
        requireThat(old.version===expected,412,'VERSION_CONFLICT','This property changed. Reload and review your draft before saving.');
        requireThat(action==='restore'?old.lifecycle_status==='archived':old.lifecycle_status==='registered',409,'INVALID_STATE','Reload the property before this operation.');
      }
      if(values?.counterpartyId) {
        const counterparty=(await ctx.sql.query(`SELECT c.id FROM hamdee_private.counterparties c WHERE c.id=$1 AND ($2 OR EXISTS(
          SELECT 1 FROM hamdee_private.properties p WHERE p.counterparty_id=c.id))`,[values.counterpartyId,ctx.grants.some(g=>g.portfolio&&permits(g,action))])).rows[0];
        requireThat(counterparty,422,'INVALID_COUNTERPARTY','The counterparty reference is unavailable.');
      }
      const propertyId=id||randomUUID();
      if(action==='create') {
        await ctx.sql.query("SELECT set_config('hamdee.new_property',$1,true)",[propertyId]);
        await ctx.sql.query(`INSERT INTO hamdee_private.properties(id,name,location,counterparty_id,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$5)`,[propertyId,values!.name,values!.location??null,values!.counterpartyId??null,ctx.user.id]);
        if(!createGrant!.portfolio) await ctx.sql.query('INSERT INTO hamdee_private.property_access(assignment_id,property_id) VALUES($1,$2)',[createGrant!.id,propertyId]);
      } else {
        const next={name:old!.name,location:old!.location,counterpartyId:old!.counterparty_id,...values};
        const updated=await ctx.sql.query<Row>(`UPDATE hamdee_private.properties SET name=$2,location=$3,counterparty_id=$4,
          lifecycle_status=$5,archived_at=CASE WHEN $5='archived' THEN clock_timestamp() ELSE NULL END,
          archived_by=CASE WHEN $5='archived' THEN $6::uuid ELSE NULL END,archive_reason=$7,
          updated_by=$6,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND version=$8 RETURNING id`,
          [propertyId,next.name,next.location,next.counterpartyId,action==='archive'?'archived':'registered',ctx.user.id,action==='archive'?reason:null,expected]);
        requireThat(updated.rows.length===1,412,'VERSION_CONFLICT','This property changed. Reload and review your draft before saving.');
      }
      const data=profile(await this.getRow(ctx,propertyId));
      await ctx.sql.query('INSERT INTO hamdee_private.property_revisions(property_id,version,profile,actor_id) VALUES($1,$2,$3,$4)',[propertyId,data.version,JSON.stringify(data),ctx.user.id]);
      await ctx.sql.query(`INSERT INTO hamdee_private.audit_events(id,property_id,version,actor_id,action,reason,changed_fields,request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),propertyId,data.version,ctx.user.id,action,reason,values?Object.keys(values):['lifecycleStatus'],requestId]);
      const result={data,status:action==='create'?201:200,replay:false};
      await ctx.sql.query(`INSERT INTO hamdee_private.commands(actor_id,operation,target,key,digest,property_id,result)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[ctx.user.id,action,id||'new',key,digest,propertyId,JSON.stringify(result)]);
      return result;
    });
  }
}
export function safeUnexpected(error:unknown):ApiError {
  return error instanceof ApiError?error:new ApiError(503,'STORAGE_UNAVAILABLE','The operation could not be confirmed. Retry the same submission.');
}
