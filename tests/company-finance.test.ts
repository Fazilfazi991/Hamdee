import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { operationsFixture,operationsMigration } from './support/operations-fixture';
import { up,adapter } from './support/fixture';
import { exactAmount } from '../src/company-finance';
const query={month:'2026-10',asOf:'2026-10-31'};
const code=(expected:string)=>(e:unknown)=>(e as {code:string}).code===expected;
async function setup(t:TestContext){const f=await operationsFixture();t.after(()=>f.pg.close());return f;}
test('Explicit confirmed opening is required, with no defaults, rounding, FX or inferred starting funds',async t=>{
 const f=await setup(t);await assert.rejects(f.account({ownerConfirmedOpening:false}),code('OPENING_UNCONFIRMED'));await assert.rejects(f.account({openingAmount:undefined}));
 for(const value of ['NaN','1e2','-1','0.0000000000001','1000000000000000000',1])assert.throws(()=>exactAmount(value));
 const a=await f.account();assert.equal((await f.finance.overview(f.identity,query)).totals[0].balance,'0');
 await assert.rejects(f.writeFinance({action:'expense',accountId:a.id,expenseKey:randomUUID(),paidOn:'2026-10-15',amount:'1'}),code('INSUFFICIENT_FUNDS'));
});
test('Classified receipt identity and actual source placement prevent duplicate receipts; exact values stay currency-separated',async t=>{
 const f=await setup(t),a=await f.account(),b=await f.account({currency:'XXX'}),receiptKey=randomUUID(),r=await f.receipt({receiptKey,amount:'9007199254740993.123456789012'});
 await assert.rejects(f.receipt({receiptKey}),code('DUPLICATE_RECEIPT'));
 const body={action:'receive',accountId:a.id,sourceKind:'classified-receipt',sourceId:r.id,ownerConfirmedDisposition:true};await f.writeFinance(body);await assert.rejects(f.writeFinance(body),code('SOURCE_ALREADY_LINKED'));
 const s=await f.finance.overview(f.identity,query);assert.equal(s.totals.find(t=>t.accountId===a.id)!.balance,'9007199254740993.123456789012');assert.equal(s.totals.find(t=>t.accountId===b.id)!.balance,'0');
 await assert.rejects(f.writeFinance({...body,accountId:b.id}),code('CURRENCY_MISMATCH'));
});
test('Company/personal transfer is a paired movement, not income; exact reversal and duplicate prevention conserve total funds',async t=>{
 const f=await setup(t),a=await f.account({openingAmount:'100'}),b=await f.account({scope:'personal',name:'Synthetic personal'});
 const body={action:'transfer',fromAccountId:a.id,toAccountId:b.id,transferredOn:'2026-10-15',amount:'40',reference:'SYN-TRANSFER'};const transfer=await f.writeFinance(body);
 await assert.rejects(f.writeFinance(body),code('DUPLICATE_TRANSFER'));let s=await f.finance.overview(f.identity,query);assert.equal(s.totals.find(t=>t.accountId===a.id)!.balance,'60');assert.equal(s.totals.find(t=>t.accountId===b.id)!.balance,'40');assert.equal(s.totals.every(t=>t.receipts==='0'),true);
 const entry=s.entries.find(e=>e.transferId===transfer.id)!;await f.writeFinance({action:'reverse',entryId:entry.id,reversedOn:'2026-10-16',reason:'Synthetic correction'});
 s=await f.finance.overview(f.identity,query);assert.equal(s.totals.find(t=>t.accountId===a.id)!.balance,'100');assert.equal(s.totals.find(t=>t.accountId===b.id)!.balance,'0');assert.equal(s.entries.filter(e=>e.entryKind==='reversal').length,2);
 await assert.rejects(f.writeFinance({action:'reverse',entryId:entry.id,reversedOn:'2026-10-17',reason:'Repeat'}),code('ALREADY_REVERSED'));
});
test('Expenses and reversals require stable identities, remain immutable, and cannot borrow a future opening',async t=>{
 const f=await setup(t),a=await f.account({openingAmount:'100',openingDate:'2026-10-10'}),expenseKey=randomUUID();
 await assert.rejects(f.writeFinance({action:'expense',accountId:a.id,expenseKey,paidOn:'2026-10-09',amount:'1'}));
 const expense=await f.writeFinance({action:'expense',accountId:a.id,expenseKey,paidOn:'2026-10-15',amount:'30'});await assert.rejects(f.writeFinance({action:'expense',accountId:a.id,expenseKey,paidOn:'2026-10-16',amount:'30'}),code('DUPLICATE_EXPENSE'));
 await f.writeFinance({action:'reverse',entryId:expense.id,reversedOn:'2026-10-16',reason:'Synthetic expense correction'});
 assert.equal((await f.finance.overview(f.identity,query)).totals[0].balance,'100');await assert.rejects(f.pg.exec('DELETE FROM hamdee_private.ops_money'));
});
test('Runtime SQL uses owner-only RLS; no public grants or staff-user schema; missing-local marker blocks additive migration',async t=>{
 const f=await setup(t);await f.account();await adapter(f.pg).transaction(async sql=>{await sql.query('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true)",[f.users.ops.id]);assert.equal((await sql.query('SELECT id FROM hamdee_private.ops_accounts')).rows.length,0);});
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec(await up());await pg.exec('DELETE FROM hamdee_private.application_identity');await assert.rejects(pg.transaction(async tx=>{await tx.exec(await operationsMigration());}));
 assert.equal((await pg.query<{name:string|null}>("SELECT to_regclass('hamdee_private.ops_collectors')::text AS name")).rows[0].name,null);
});
