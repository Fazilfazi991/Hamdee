import type {Identity} from './auth';
import {PropertyService} from './service';
import {date,month} from './rental';
import {requireThat} from './errors';

export const dailyDashboardBasis='Recorded accounts/custody as of date; selected-month issued rent and dated allocations; expense dates and payments separate. Advances allocate existing funds, deposits remain separate; transfers and handovers are not new income. No historical or demo reference amounts are included.';
export const businessOverviewBasis=Object.freeze({
  totalCollected:'Allocated to issued rent dues for the selected reporting month through the cutoff; not all business revenue. Deposits and unallocated advances are excluded.',
  trendCollections:'Original recorded cash/bank rent and car receipts by actual receipt date. All advances, deposits, pending cheques, transfers and staff handovers are excluded.',
  expenses:'Recorded property & vehicle costs by expense date. Standalone company/personal ledger expenses are not added; these are not comprehensive business expenses or distributable profit.',
  balances:'Company accounts with owner-confirmed openings and recorded movements through the cutoff only. Staff custody and personal accounts remain separate.'
});
export class DailyDashboardService {
  constructor(private readonly properties:PropertyService){}
  async overview(identity:Identity,query:{month:string;asOf:string}) {
    const period=month(query.month),asOf=date(query.asOf);
    return this.properties.ownerContext(identity,async sql=>{
      const installed=(await sql.query<{ready:boolean;cars:boolean}>(`SELECT to_regclass('hamdee_private.ops_money') IS NOT NULL
        AND to_regclass('hamdee_private.ops_accounts') IS NOT NULL AND to_regclass('hamdee_private.ops_collectors') IS NOT NULL AS ready,
        to_regclass('hamdee_private.car_receipts') IS NOT NULL AND to_regclass('hamdee_private.car_expenses') IS NOT NULL
        AND to_regclass('hamdee_private.car_agreements') IS NOT NULL AS cars`)).rows[0];
      requireThat(installed?.ready,503,'OPERATIONS_UNAVAILABLE','The existing operations database is unavailable.');
      // One statement snapshot. These are the existing ledger deltas, explicit
      // due allocations and expense/payment date bases; no receipt is reposted.
      const result=(await sql.query<{data:Record<string,unknown>}>(`WITH
      due_values AS (
        SELECT d.*,coalesce(sum(a.amount_minor) FILTER(WHERE a.allocated_date<=$2::date),0) AS paid_minor
        FROM hamdee_private.rent_dues d LEFT JOIN hamdee_private.rent_allocations a ON a.due_id=d.id
        WHERE d.period=$1 GROUP BY d.id
      ), rent_totals AS (
        SELECT currency,sum(amount_minor) AS expected_minor,sum(paid_minor) AS allocated_minor FROM due_values GROUP BY currency
      ), receipt_values AS (
        SELECT c.*,coalesce((SELECT sum(a.amount_minor) FROM hamdee_private.rent_allocations a WHERE a.collection_id=c.id AND a.allocated_date<=$2::date),0) AS allocated_minor
        FROM hamdee_private.rent_collections c WHERE c.received_date<=$2::date
      ), receipt_totals AS (
        SELECT currency,
          coalesce(sum(amount_minor-allocated_minor) FILTER(WHERE kind='advance' AND status='recorded'),0) AS advance_minor,
          coalesce(sum(CASE kind WHEN 'deposit' THEN amount_minor WHEN 'deposit_refund' THEN -amount_minor ELSE 0 END) FILTER(WHERE status='recorded'),0) AS deposit_minor,
          coalesce(sum(amount_minor) FILTER(WHERE status='pending' AND to_char(received_date,'YYYY-MM')=$1),0) AS cheque_minor
        FROM receipt_values GROUP BY currency
      ), rent_currencies AS (SELECT currency FROM rent_totals UNION SELECT currency FROM receipt_totals),
      expense_costs AS (
        SELECT currency,sum(amount_minor) AS recorded_minor FROM hamdee_private.property_expenses
        WHERE to_char(expense_date,'YYYY-MM')=$1 AND expense_date<=$2::date GROUP BY currency
      ), expense_cash AS (
        SELECT e.currency,coalesce(sum(p.amount_minor) FILTER(WHERE p.status='recorded'),0) AS paid_minor,
          coalesce(sum(p.amount_minor) FILTER(WHERE p.status='pending'),0) AS cheque_minor
        FROM hamdee_private.expense_payments p JOIN hamdee_private.property_expenses e ON e.id=p.expense_id
        WHERE to_char(p.payment_date,'YYYY-MM')=$1 AND p.payment_date<=$2::date GROUP BY e.currency
      ), expense_currencies AS (SELECT currency FROM expense_costs UNION SELECT currency FROM expense_cash),
      account_values AS (
        SELECT a.*,CASE WHEN a.opening_date<=$2::date THEN coalesce(sum(m.delta) FILTER(WHERE m.business_date<=$2::date),0) ELSE NULL END AS balance
        FROM hamdee_private.ops_accounts a LEFT JOIN hamdee_private.ops_money m ON m.account_id=a.id AND m.location_type='account'
        WHERE a.owner_confirmed GROUP BY a.id
      ), staff_values AS (
        SELECT c.id AS collector_id,c.name,m.currency,sum(m.delta) AS balance FROM hamdee_private.ops_collectors c
        JOIN hamdee_private.ops_money m ON m.collector_id=c.id AND m.location_type='collector' AND m.business_date<=$2::date GROUP BY c.id,m.currency
      ), company_currencies AS (
        SELECT currency FROM account_values WHERE scope='company' AND opening_date<=$2::date
        UNION SELECT currency FROM staff_values UNION SELECT currency FROM rent_currencies UNION SELECT currency FROM expense_currencies
      ), car_receipt_values AS (
        ${installed.cars?`SELECT currency,received_date,amount,method,status FROM hamdee_private.car_receipts WHERE received_date<=$2::date`:
          `SELECT NULL::text AS currency,NULL::date AS received_date,0::numeric AS amount,NULL::text AS method,NULL::text AS status WHERE false`}
      ), car_currency_history AS (
        ${installed.cars?`SELECT DISTINCT currency FROM hamdee_private.car_agreements`:`SELECT NULL::text AS currency WHERE false`}
      ), cost_values AS (
        SELECT currency,expense_date,amount_minor/100.0 AS amount FROM hamdee_private.property_expenses WHERE expense_date<=$2::date
        ${installed.cars?`UNION ALL SELECT currency,expense_date,amount FROM hamdee_private.car_expenses WHERE expense_date<=$2::date`:''}
      ), business_currencies AS (
        SELECT currency FROM company_currencies UNION SELECT currency FROM account_values WHERE scope='company'
        UNION SELECT currency FROM car_currency_history UNION SELECT currency FROM cost_values UNION SELECT currency FROM car_receipt_values
      ), monthly_car AS (
        SELECT currency,coalesce(sum(amount) FILTER(WHERE status='recorded' AND method IN ('cash','bank') AND to_char(received_date,'YYYY-MM')=$1),0) AS collected,
          coalesce(sum(amount) FILTER(WHERE status='pending'),0) AS pending
        FROM car_receipt_values GROUP BY currency
      ), monthly_costs AS (
        SELECT currency,coalesce(sum(amount) FILTER(WHERE to_char(expense_date,'YYYY-MM')=$1),0) AS amount FROM cost_values GROUP BY currency
      ), rental_pending AS (
        SELECT currency,coalesce(sum(amount_minor/100.0) FILTER(WHERE status='pending'),0) AS amount FROM receipt_values GROUP BY currency
      ), upcoming_totals AS (
        SELECT currency,sum((amount_minor-paid_minor)/100.0) AS amount,count(*)::int AS count,min(due_date) AS next_date
        FROM due_values WHERE due_date>=$2::date AND amount_minor>paid_minor GROUP BY currency
      ), overdue_totals AS (
        SELECT currency,sum((amount_minor-paid_minor)/100.0) AS amount,count(*)::int AS count,min(due_date) AS oldest_date
        FROM due_values WHERE due_date<$2::date AND amount_minor>paid_minor GROUP BY currency
      ), trend_events AS (
        SELECT currency,received_date AS business_date,amount_minor/100.0 AS amount,'collection' AS kind
        FROM receipt_values WHERE kind='rent' AND status='recorded' AND method IN ('cash','bank')
          AND received_date>=(($1||'-01')::date-interval '5 months') AND received_date<(($1||'-01')::date+interval '1 month')
        UNION ALL SELECT currency,received_date,amount,'collection' FROM car_receipt_values WHERE status='recorded' AND method IN ('cash','bank')
          AND received_date>=(($1||'-01')::date-interval '5 months') AND received_date<(($1||'-01')::date+interval '1 month')
        UNION ALL SELECT currency,expense_date,amount,'cost' FROM cost_values
          WHERE expense_date>=(($1||'-01')::date-interval '5 months') AND expense_date<(($1||'-01')::date+interval '1 month')
      ), trend_values AS (
        SELECT currency,to_char(business_date,'YYYY-MM') AS month,
          coalesce(sum(amount) FILTER(WHERE kind='collection'),0) AS collections,coalesce(sum(amount) FILTER(WHERE kind='cost'),0) AS expenses
        FROM trend_events GROUP BY currency,to_char(business_date,'YYYY-MM')
      ), recent AS (
        SELECT c.*,p.name AS property_name,r.code AS room_code,t.name AS tenant_name FROM receipt_values c
        JOIN hamdee_private.properties p ON p.id=c.property_id JOIN hamdee_private.rooms r ON r.id=c.room_id
        JOIN hamdee_private.rental_agreements a ON a.id=c.agreement_id JOIN hamdee_private.tenants t ON t.id=a.tenant_id
        ORDER BY c.received_date DESC,c.id DESC LIMIT 10
      ), upcoming AS (
        SELECT d.*,p.name AS property_name,r.code AS room_code,t.name AS tenant_name FROM due_values d
        JOIN hamdee_private.properties p ON p.id=d.property_id JOIN hamdee_private.rooms r ON r.id=d.room_id
        JOIN hamdee_private.rental_agreements a ON a.id=d.agreement_id JOIN hamdee_private.tenants t ON t.id=a.tenant_id
        WHERE d.due_date>=$2::date AND d.amount_minor>d.paid_minor ORDER BY d.due_date,d.id LIMIT 10
      ) SELECT jsonb_build_object(
        'overview',jsonb_build_object('currencies',coalesce((SELECT jsonb_agg(jsonb_build_object(
          'currency',k.currency,
          'totalCollected',trim_scale(r.allocated_minor/100.0)::text,'pendingCollection',trim_scale((r.expected_minor-r.allocated_minor)/100.0)::text,
          'companyCash',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='company' AND kind='cash' AND currency=k.currency AND opening_date<=$2::date),
          'companyBank',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='company' AND kind='bank' AND currency=k.currency AND opening_date<=$2::date),
          'monthlyExpenses',trim_scale(e.amount)::text,
          'rent',jsonb_build_object('expected',trim_scale(r.expected_minor/100.0)::text,'allocated',trim_scale(r.allocated_minor/100.0)::text,
            'outstanding',trim_scale((r.expected_minor-r.allocated_minor)/100.0)::text,
            'unappliedAdvances',trim_scale(coalesce(rc.advance_minor,0)/100.0)::text,'depositHeld',trim_scale(coalesce(rc.deposit_minor,0)/100.0)::text,
            'pendingCheques',trim_scale(coalesce(rp.amount,0))::text),
          'operations',jsonb_build_object(
            'carCollected',CASE WHEN EXISTS(SELECT 1 FROM car_currency_history WHERE currency=k.currency) OR c.currency IS NOT NULL THEN trim_scale(coalesce(c.collected,0))::text END,
            'staffHeld',CASE WHEN EXISTS(SELECT 1 FROM hamdee_private.ops_collectors) THEN trim_scale(coalesce((SELECT sum(balance) FROM staff_values WHERE currency=k.currency),0))::text END,
            'pendingCheques',trim_scale(coalesce(rp.amount,0)+coalesce(c.pending,0))::text,
            'pendingRentCheques',trim_scale(coalesce(rp.amount,0))::text,'pendingCarCheques',trim_scale(coalesce(c.pending,0))::text,
            'upcomingAmount',CASE WHEN r.currency IS NOT NULL THEN trim_scale(coalesce(u.amount,0))::text END,
            'upcomingCount',coalesce(u.count,0),'nextDueDate',u.next_date,
            'overdueAmount',CASE WHEN r.currency IS NOT NULL THEN trim_scale(coalesce(o.amount,0))::text END,
            'overdueCount',coalesce(o.count,0),'oldestOverdueDate',o.oldest_date),
          'trend',coalesce((SELECT jsonb_agg(jsonb_build_object('month',t.month,'collections',trim_scale(t.collections)::text,'expenses',trim_scale(t.expenses)::text) ORDER BY t.month)
            FROM trend_values t WHERE t.currency=k.currency),'[]'::jsonb),
          'trendReady',(SELECT count(*)>=2 FROM trend_values t WHERE t.currency=k.currency)
        ) ORDER BY k.currency) FROM business_currencies k LEFT JOIN rent_totals r USING(currency) LEFT JOIN receipt_totals rc USING(currency)
          LEFT JOIN monthly_car c USING(currency) LEFT JOIN monthly_costs e USING(currency) LEFT JOIN rental_pending rp USING(currency)
          LEFT JOIN upcoming_totals u USING(currency) LEFT JOIN overdue_totals o USING(currency)),'[]'::jsonb)),
        'accounts',jsonb_build_object(
          'companySetupRequired',NOT EXISTS(SELECT 1 FROM account_values WHERE scope='company' AND opening_date<=$2::date),
          'personalSetupRequired',NOT EXISTS(SELECT 1 FROM account_values WHERE scope='personal' AND opening_date<=$2::date),
          'company',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind,'currency',currency,'openingDate',opening_date,'balance',trim_scale(balance)::text) ORDER BY id) FROM account_values WHERE scope='company'),'[]'::jsonb),
          'personal',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind,'currency',currency,'openingDate',opening_date,'balance',trim_scale(balance)::text) ORDER BY id) FROM account_values WHERE scope='personal'),'[]'::jsonb)),
        'balances',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',k.currency,
          'companyCash',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='company' AND kind='cash' AND currency=k.currency AND opening_date<=$2::date),
          'companyBank',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='company' AND kind='bank' AND currency=k.currency AND opening_date<=$2::date),
          'staffHeld',trim_scale(coalesce((SELECT sum(balance) FROM staff_values WHERE currency=k.currency),0))::text) ORDER BY k.currency) FROM company_currencies k),'[]'::jsonb),
        'personalBalances',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',k.currency,
          'cash',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='personal' AND kind='cash' AND currency=k.currency AND opening_date<=$2::date),
          'bank',(SELECT trim_scale(sum(balance))::text FROM account_values WHERE scope='personal' AND kind='bank' AND currency=k.currency AND opening_date<=$2::date)) ORDER BY k.currency)
          FROM (SELECT DISTINCT currency FROM account_values WHERE scope='personal') k),'[]'::jsonb),
        'rent',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',k.currency,
          'expected',trim_scale(coalesce(d.expected_minor,0)/100.0)::text,'allocated',trim_scale(coalesce(d.allocated_minor,0)/100.0)::text,
          'outstanding',trim_scale((coalesce(d.expected_minor,0)-coalesce(d.allocated_minor,0))/100.0)::text,
          'unappliedAdvances',trim_scale(coalesce(c.advance_minor,0)/100.0)::text,'depositHeld',trim_scale(coalesce(c.deposit_minor,0)/100.0)::text,
          'pendingCheques',trim_scale(coalesce(c.cheque_minor,0)/100.0)::text) ORDER BY k.currency)
          FROM rent_currencies k LEFT JOIN rent_totals d USING(currency) LEFT JOIN receipt_totals c USING(currency)),'[]'::jsonb),
        'expenses',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',k.currency,'recorded',trim_scale(coalesce(e.recorded_minor,0)/100.0)::text,
          'paid',trim_scale(coalesce(c.paid_minor,0)/100.0)::text,'pendingCheques',trim_scale(coalesce(c.cheque_minor,0)/100.0)::text) ORDER BY k.currency)
          FROM expense_currencies k LEFT JOIN expense_costs e USING(currency) LEFT JOIN expense_cash c USING(currency)),'[]'::jsonb),
        'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('collectorId',collector_id,'name',name,'currency',currency,'balance',trim_scale(balance)::text) ORDER BY collector_id,currency) FROM staff_values),'[]'::jsonb),
        'recentCollections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'propertyId',property_id,'propertyName',property_name,'roomId',room_id,'roomCode',room_code,'tenantName',tenant_name,
          'date',received_date,'kind',kind,'method',method,'status',status,'currency',currency,'amount',trim_scale(amount_minor/100.0)::text) ORDER BY received_date DESC,id DESC) FROM recent),'[]'::jsonb),
        'upcomingDues',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'agreementId',agreement_id,'propertyId',property_id,'propertyName',property_name,'roomId',room_id,'roomCode',room_code,'tenantName',tenant_name,
          'period',period,'dueDate',due_date,'currency',currency,'amount',trim_scale(amount_minor/100.0)::text,'paid',trim_scale(paid_minor/100.0)::text,'outstanding',trim_scale((amount_minor-paid_minor)/100.0)::text) ORDER BY due_date,id) FROM upcoming),'[]'::jsonb)
      ) AS data`,[period,asOf])).rows[0].data;
      const overview=result.overview as {currencies:unknown[]};
      return {...result,overviewVersion:1 as const,overview:{...overview,basis:businessOverviewBasis},month:period,asOf,moneyUnit:'decimal-major-unit-strings' as const,basis:dailyDashboardBasis};
    });
  }
}
