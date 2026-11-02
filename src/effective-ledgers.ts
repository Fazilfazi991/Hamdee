import type {Sql} from './database';

/** Source rows remain immutable. Dated compensations are exposed only to reads. */
export async function effectiveLedgerSql(sql:Sql):Promise<Sql>{
 const ready=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.financial_corrections') IS NOT NULL AS ready")).rows[0]?.ready;
 if(!ready)return sql;
 const names:Record<string,string>={expense_payments:'expense_payment_effects',rent_collections:'rental_collection_effects',security_deposit_refunds:'security_deposit_refund_effects'};
 return {query:<T>(statement:string,params?:unknown[])=>sql.query<T>(/^\s*(SELECT|WITH)\b/i.test(statement)?statement.replace(/hamdee_private\.(expense_payments|rent_collections|security_deposit_refunds)\b/g,(_,name:string)=>'hamdee_private.'+names[name]):statement,params)};
}
