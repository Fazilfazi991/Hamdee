import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { adapter,issuer } from './support/fixture';
import { PropertyService } from '../src/service';
const migration=(file:string)=>readFile(new URL('../migrations/'+file,import.meta.url),'utf8');

test('PGLITE MIGRATION: upgrade from 001 preserves an existing property and its issued metadata history',async()=>{
  const pg=new PGlite();try{
    await pg.exec(await migration('001_property_foundation.up.sql'));
    const id=randomUUID(),subject=randomUUID();
    await pg.query('INSERT INTO hamdee_private.app_users VALUES($1,$2,$3,$4,true)',[id,issuer,subject,'Synthetic migration user']);
    await pg.query("INSERT INTO hamdee_private.role_assignments VALUES($1,$2,'admin',true,NULL)",[randomUUID(),id]);
    const service=new PropertyService(adapter(pg)),identity={issuer,subject};
    const result=await service.mutate(identity,{action:'create',key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic pre-upgrade property'}});
    await pg.transaction(async tx=>{await tx.exec(await migration('002_property_hardening.up.sql'));});
    assert.deepEqual(await service.get(identity,result.data.id as string),result.data);
    assert.equal((await service.audit(identity,result.data.id as string,50,0)).data.length,1);
    const changed=await service.mutate(identity,{action:'update',id:result.data.id as string,expected:1,key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic post-upgrade property'}});assert.equal(changed.data.version,2);
  }finally{await pg.close();}
});

test('PGLITE MIGRATION: unsafe existing role is rejected without a partial hardening migration',async()=>{
  const pg=new PGlite();try{
    await pg.exec(await migration('001_property_foundation.up.sql'));await pg.exec('ALTER ROLE hamdee_runtime BYPASSRLS');
    await assert.rejects(()=>pg.transaction(async tx=>{await tx.exec(await migration('002_property_hardening.up.sql'));}),/unsafe existing/);
    assert.equal((await pg.query("SELECT 1 FROM pg_constraint WHERE conname='property_current_revision'")).rows.length,0);
  }finally{await pg.close();}
});
