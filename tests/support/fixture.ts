import { PGlite, type Transaction } from '@electric-sql/pglite';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database, Sql } from '../../src/database';
import type { IdentityProvider, Identity } from '../../src/auth';
import { ApiError } from '../../src/errors';
import { PropertyService } from '../../src/service';
import { createHandler } from '../../src/http';
export const issuer='https://isolated-hamdee-tests.invalid/auth/v1';
export const up=async()=>(await Promise.all(['001_property_foundation.up.sql','002_property_hardening.up.sql'].map(file=>readFile(new URL('../../migrations/'+file,import.meta.url),'utf8')))).join('\n');
// This provider exists only in automated tests. No environment variable,
// production route or build import can activate it.
export class TestIdentityProvider implements IdentityProvider {
  readonly kind='automated-test';
  private tokens=new Map<string,{identity:Identity;expires:number}>();
  issue(subject:string,tokenIssuer=issuer,expires=Date.now()+600000) {
    const token=randomBytes(32).toString('hex'); this.tokens.set(token,{identity:{issuer:tokenIssuer,subject},expires});return token;
  }
  async validate(request:Request) {
    const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
    const entry=this.tokens.get(token||'');
    if(!entry||entry.expires<=Date.now())throw new ApiError(401,'UNAUTHENTICATED','Sign in with an authorized account.');
    return entry.identity;
  }
}
export function adapter(pg:PGlite):Database {
  return {transaction:<T>(work:(sql:Sql)=>Promise<T>)=>pg.transaction((tx:Transaction)=>work({query:async <R>(sql:string,params?:unknown[])=>({rows:(await tx.query<R>(sql,params)).rows})}))};
}
export async function fixture(persistent=false) {
  const dataDir=persistent?path.resolve('.test-data',randomUUID()):undefined;
  if(dataDir)await mkdir(dataDir,{recursive:true});
  const pg=new PGlite(dataDir);
  await pg.transaction(async tx=>{await tx.exec(await up());});
  const provider=new TestIdentityProvider();
  const users:Record<string,{id:string;assignment:string;token:string;subject:string}>={};
  for(const [name,role,portfolio,enabled] of [
    ['admin','admin',true,true],['ops','operations',false,true],['finance','finance',false,true],
    ['reader','read_only',false,true],['unassigned','read_only',false,true],['disabled','admin',true,false],['scopedAdmin','admin',false,true]
  ] as const) {
    const id=randomUUID(),assignment=randomUUID(),subject=randomUUID();
    await pg.query('INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$4,$5)',[id,issuer,subject,'Synthetic '+name,enabled]);
    await pg.query('INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,$3,$4)',[assignment,id,role,portfolio]);
    users[name]={id,assignment,subject,token:provider.issue(subject)};
  }
  const service=new PropertyService(adapter(pg));
  const handle=createHandler(provider,service,()=>{});
  const request=async (user:string|null,method:string,route:string,body?:unknown,extra:Record<string,string>={})=>{
    const headers:Record<string,string>={Origin:'http://127.0.0.1:4181','Content-Type':'application/json',...extra};
    if(user)headers.Authorization='Bearer '+(users[user]?.token||user);
    return handle(new Request('http://127.0.0.1:4181/api/hamdee/v1'+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}));
  };
  const create=async(user='admin',name='Synthetic property')=>{
    const response=await request(user,'POST','/properties',{name},{'Idempotency-Key':randomUUID()});
    if(response.status!==201)throw new Error('fixture create '+response.status+' '+await response.text());
    return (await response.json()).data;
  };
  return {pg,provider,users,service,handle,request,create,dataDir};
}
