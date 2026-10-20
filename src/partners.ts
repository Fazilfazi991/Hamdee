/** LOCAL module; Coordinator must explicitly wire owner-only APIs after review.
 * GET /api/hamdee/v1/partners -> overview(identity, query)
 * POST /api/hamdee/v1/partners/commands -> mutate(identity, body, key, requestId)
 * Reuse existing verified owner, CSRF/Origin, size/no-store/error handling.
 * The existing owner HTTP composition registers these guarded routes.
 * Migration 008 is disposable-local; hosted publication is separately gated.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Identity } from './auth';
import type { Sql } from './database';
import { PropertyService } from './service';
import { requireThat } from './errors';
import { uuid } from './validation';
import { canonical, date, month, text, id } from './rental';

type Row = Record<string, unknown>;
export interface PartnerQuery {
  month: string; asOf: string; propertyId?: string; partnerId?: string;
  recordedThrough?: string; entryCursor?: string; partnerCursor?: string; limit?: number;
}
const check = (ok: unknown, message: string, code = 'INVALID_PARTNER', status = 422) => requireThat(ok, status, code, message);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function partnerAmount(value: unknown): string {
  check(typeof value === 'string' && /^\d{1,18}(\.\d{1,12})?$/.test(value), 'Enter a positive decimal amount: up to 18 whole digits and 12 decimal places.', 'INVALID_PARTNER_AMOUNT');
  const [whole, fraction = ''] = (value as string).split('.');
  const cleanWhole = BigInt(whole).toString(), cleanFraction = fraction.replace(/0+$/, '');
  check(cleanWhole !== '0' || cleanFraction !== '', 'Enter an amount greater than zero.', 'INVALID_PARTNER_AMOUNT');
  return cleanWhole + (cleanFraction ? '.' + cleanFraction : '');
}
function dto(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'event_id').map(([k, v]) => [
    k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    v instanceof Date ? v.toISOString().slice(0, k === 'entry_date' ? 10 : 24) : v,
  ]));
}
function normalized(input: unknown): Row {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Submit a partner record operation.');
  const b = input as Row, action = b.action;
  const allow: Record<string, string[]> = {
    'create-partner': ['name', 'phone', 'email', 'notes'],
    'update-partner': ['partnerId', 'expectedVersion', 'name', 'phone', 'email', 'notes'],
    'link-property': ['propertyId', 'partnerId', 'notes'],
    'record-entry': ['propertyId', 'partnerId', 'kind', 'entryDate', 'amount', 'currency', 'reference', 'notes'],
  };
  check(typeof action === 'string' && Object.hasOwn(allow, action) && Object.keys(b).every(k => k === 'action' || allow[action].includes(k)), 'Unknown operation or fields.');
  const result: Row = { action };
  if (action !== 'create-partner') result.partnerId = id(b.partnerId);
  if (action === 'create-partner' || action === 'update-partner') {
    if (action === 'update-partner') {
      check(Number.isSafeInteger(b.expectedVersion) && Number(b.expectedVersion) > 0, 'Supply the current partner revision.', 'PRECONDITION_REQUIRED', 428);
      check(['name', 'phone', 'email', 'notes'].some(k => k in b), 'Enter contact changes.');
      result.expectedVersion = b.expectedVersion;
    }
    for (const [key, max] of [['name', 200], ['phone', 60], ['email', 254], ['notes', 2000]] as const) {
      if (action === 'create-partner' || key in b) result[key] = text(b[key] ?? (key === 'name' ? undefined : ''), max, key === 'name');
    }
    if (result.email) check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(result.email)), 'Check the email address.');
  } else {
    result.propertyId = id(b.propertyId); result.notes = text(b.notes ?? '', 2000, false);
    if (action === 'record-entry') {
      check(b.kind === 'contribution' || b.kind === 'withdrawal', 'Choose recorded contribution or withdrawal.');
      const currency = text(b.currency, 3); check(/^[A-Z]{3}$/.test(currency), 'Enter an explicit three-letter currency code.');
      Object.assign(result, { kind: b.kind, entryDate: date(b.entryDate), amount: partnerAmount(b.amount), currency, reference: text(b.reference ?? '', 200, false) });
    }
  }
  return result;
}

export class PartnerService {
  constructor(private readonly properties: PropertyService) {}

  async mutate(identity: Identity, input: unknown, key: string, requestId: string) {
    check(typeof key === 'string' && uuid.test(key), 'Use a valid operation key.', 'IDEMPOTENCY_KEY_REQUIRED', 400);
    check(typeof requestId === 'string' && uuid.test(requestId), 'Use a valid request identifier.', 'INVALID_REQUEST', 400);
    const b = normalized(input), digest = hash({ api: 'partners-v1', body: b });
    return this.properties.ownerContext(identity, async (sql, actorId) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['partner-command:' + actorId + ':' + key]);
      if (b.propertyId) await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['property:' + b.propertyId]);
      if (b.partnerId) await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['partner:' + b.partnerId]);
      const saved = (await sql.query<{ digest: string; result: { data: Row; status: number; replay: boolean } }>(
        'SELECT digest,result FROM hamdee_private.partner_commands WHERE actor_id=$1 AND key=$2', [actorId, key])).rows[0];
      // ownerContext always revalidates enabled owner membership/session on replay.
      if (saved) { check(saved.digest === digest, 'Use a new operation key for a changed submission.', 'IDEMPOTENCY_KEY_REUSED', 409); return { ...saved.result, replay: true }; }
      let current: Row | undefined;
      if (b.partnerId) {
        current = (await sql.query<Row>('SELECT * FROM hamdee_private.partners WHERE id=$1', [b.partnerId])).rows[0];
        check(current, 'Partner not found.', 'NOT_FOUND', 404);
      }
      if (b.propertyId) {
        const p = (await sql.query<Row>('SELECT id,lifecycle_status FROM hamdee_private.properties WHERE id=$1', [b.propertyId])).rows[0];
        check(p, 'Property not found.', 'NOT_FOUND', 404);
        check(p.lifecycle_status === 'registered', 'Restore the property before recording a new partner link or movement.', 'PROPERTY_ARCHIVED', 409);
      }
      const eventId = randomUUID(), partnerId = String(b.partnerId ?? randomUUID());
      let row: Row, entityId = partnerId;
      if (b.action === 'create-partner') {
        row = (await sql.query<Row>(`INSERT INTO hamdee_private.partners(id,name,phone,email,notes,created_by,event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [partnerId, b.name, b.phone, b.email, b.notes, actorId, eventId])).rows[0];
      } else if (b.action === 'update-partner') {
        check(current!.version === b.expectedVersion, 'This partner changed. Reload and review the contact draft.', 'VERSION_CONFLICT', 412);
        row = (await sql.query<Row>(`UPDATE hamdee_private.partners SET name=$2,phone=$3,email=$4,notes=$5,version=version+1,event_id=$6
          WHERE id=$1 AND version=$7 RETURNING *`, [partnerId, b.name ?? current!.name, b.phone ?? current!.phone, b.email ?? current!.email, b.notes ?? current!.notes, eventId, b.expectedVersion])).rows[0];
        check(row, 'This partner changed. Reload and review the contact draft.', 'VERSION_CONFLICT', 412);
      } else if (b.action === 'link-property') {
        check(!(await sql.query('SELECT id FROM hamdee_private.property_partners WHERE property_id=$1 AND partner_id=$2', [b.propertyId, partnerId])).rows.length,
          'This partner is already linked to this property.', 'PARTNER_ALREADY_LINKED', 409);
        entityId = randomUUID();
        row = (await sql.query<Row>(`INSERT INTO hamdee_private.property_partners(id,property_id,partner_id,notes,event_id)
          VALUES($1,$2,$3,$4,$5) RETURNING *`, [entityId, b.propertyId, partnerId, b.notes, eventId])).rows[0];
      } else {
        check((await sql.query('SELECT id FROM hamdee_private.property_partners WHERE property_id=$1 AND partner_id=$2', [b.propertyId, partnerId])).rows.length,
          'Link the partner to this property before recording a movement.', 'PARTNER_NOT_LINKED', 409);
        entityId = randomUUID();
        row = (await sql.query<Row>(`INSERT INTO hamdee_private.partner_entries(id,property_id,partner_id,kind,entry_date,amount,currency,reference,notes,event_id)
          VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10) RETURNING *,amount::text AS amount`,
        [entityId, b.propertyId, partnerId, b.kind, b.entryDate, b.amount, b.currency, b.reference, b.notes, eventId])).rows[0];
      }
      // SQL-generated JSON preserves database timestamp/date representation in
      // evidence; entry amounts stay strings, never JSON binary-float numbers.
      const table = b.action === 'create-partner' || b.action === 'update-partner' ? 'partners' : b.action === 'link-property' ? 'property_partners' : 'partner_entries';
      const evidence = (await sql.query<{ detail: Row }>(`SELECT (to_jsonb(r)-'event_id'${table === 'partner_entries' ? "-'amount'||jsonb_build_object('amount',r.amount::text)" : ''}) AS detail
        FROM hamdee_private.${table} r WHERE id=$1`, [entityId])).rows[0].detail;
      await sql.query(`INSERT INTO hamdee_private.partner_events(id,partner_id,property_id,entity_id,action,detail,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [eventId, partnerId, b.propertyId ?? null, entityId, b.action, JSON.stringify({ record: evidence, requestId }), actorId]);
      if (table === 'partners') await sql.query('INSERT INTO hamdee_private.partner_revisions(partner_id,version,profile,event_id) VALUES($1,$2,$3,$4)', [partnerId, row.version, JSON.stringify(evidence), eventId]);
      const result = { data: dto(row), status: 201, replay: false };
      if (b.action === 'update-partner') result.status = 200;
      await sql.query('INSERT INTO hamdee_private.partner_commands(actor_id,key,digest,result) VALUES($1,$2,$3,$4)', [actorId, key, digest, JSON.stringify(result)]);
      return result;
    });
  }

  async overview(identity: Identity, query: PartnerQuery) {
    const period = month(query.month), asOf = date(query.asOf), start = period + '-01';
    const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const through = asOf < end ? asOf : end, propertyId = query.propertyId ? id(query.propertyId) : null, partnerId = query.partnerId ? id(query.partnerId) : null;
    const limit = query.limit ?? 100; check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Choose a page size from 1 to 100.');
    const partnerCursor = query.partnerCursor ? id(query.partnerCursor) : null;
    let recordedThrough: string | null = null;
    if (query.recordedThrough) {
      check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(query.recordedThrough) && Number.isFinite(Date.parse(query.recordedThrough)) && new Date(query.recordedThrough).toISOString().slice(0, 19) === query.recordedThrough.slice(0, 19),
        'Use the returned UTC recorded-through timestamp.');
      recordedThrough = query.recordedThrough;
    }
    let entryCursor: string | null = null, cursorDate: string | null = null;
    const scope = hash({ propertyId, partnerId, period, through });
    if (query.entryCursor) {
      check(query.entryCursor.length <= 512 && /^[\w-]+$/.test(query.entryCursor), 'Reload the statement page.', 'INVALID_CURSOR', 400);
      let cursor: Row;
      try { cursor = JSON.parse(Buffer.from(query.entryCursor, 'base64url').toString('utf8')); } catch { check(false, 'Reload the statement page.', 'INVALID_CURSOR', 400); }
      check(cursor! && typeof cursor! === 'object' && !Array.isArray(cursor!) && cursor!.scope === scope && typeof cursor!.recordedThrough === 'string', 'Reload the statement page.', 'INVALID_CURSOR', 400);
      entryCursor = id(cursor!.id); cursorDate = date(cursor!.date);
      check(!recordedThrough || recordedThrough === cursor!.recordedThrough, 'Reload the statement page.', 'INVALID_CURSOR', 400);
      check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(String(cursor!.recordedThrough)) && Number.isFinite(Date.parse(String(cursor!.recordedThrough))), 'Reload the statement page.', 'INVALID_CURSOR', 400);
      recordedThrough = String(cursor!.recordedThrough);
    }
    return this.properties.ownerContext(identity, async sql => {
      await this.existing(sql, propertyId, partnerId);
      // ONE statement snapshot for rows, monthly reports and currency totals.
      const result = (await sql.query<{ data: { partners: Row[]; partnerLabels:Record<string,string>; links: Row[]; entries: Row[]; history: Row[]; summary: Row[]; currencies: Row[]; recordedThrough: string } }>(`
        WITH cutoff AS (SELECT coalesce($5::timestamptz,clock_timestamp()) AS recorded_through),
        eligible AS (SELECT e.* FROM hamdee_private.partner_entries e,cutoff c
          WHERE ($1::uuid IS NULL OR e.property_id=$1) AND ($2::uuid IS NULL OR e.partner_id=$2)
            AND e.entry_date<=$4::date AND e.recorded_at<=c.recorded_through),
        groups AS (SELECT property_id,partner_id,currency,
          coalesce(sum(amount) FILTER (WHERE kind='contribution' AND entry_date<$3::date),0) AS opening_contributions,
          coalesce(sum(amount) FILTER (WHERE kind='withdrawal' AND entry_date<$3::date),0) AS opening_withdrawals,
          coalesce(sum(amount) FILTER (WHERE kind='contribution' AND entry_date>=$3::date),0) AS month_contributions,
          coalesce(sum(amount) FILTER (WHERE kind='withdrawal' AND entry_date>=$3::date),0) AS month_withdrawals,
          coalesce(sum(amount) FILTER (WHERE kind='contribution'),0) AS contributions_to_date,
          coalesce(sum(amount) FILTER (WHERE kind='withdrawal'),0) AS withdrawals_to_date
          FROM eligible GROUP BY property_id,partner_id,currency),
        grouped_json AS (SELECT property_id,partner_id,currency,jsonb_build_object(
          'propertyId',property_id,'partnerId',partner_id,'currency',currency,
          'openingContributions',opening_contributions::text,'openingWithdrawals',opening_withdrawals::text,
          'monthContributions',month_contributions::text,'monthWithdrawals',month_withdrawals::text,
          'contributionsToDate',contributions_to_date::text,'withdrawalsToDate',withdrawals_to_date::text,
          'recordedNet',(contributions_to_date-withdrawals_to_date)::text) AS record FROM groups),
        history_page AS (SELECT h.* FROM hamdee_private.partner_events h,cutoff c
          WHERE ($1::uuid IS NULL OR h.property_id=$1) AND ($2::uuid IS NULL OR h.partner_id=$2)
          AND h.occurred_at<=c.recorded_through ORDER BY h.occurred_at DESC,h.id DESC LIMIT $8),
        visible_partner_ids AS (SELECT partner_id FROM eligible
          UNION SELECT partner_id FROM hamdee_private.property_partners WHERE ($1::uuid IS NULL OR property_id=$1) AND ($2::uuid IS NULL OR partner_id=$2)
          UNION SELECT partner_id FROM history_page)
        SELECT jsonb_build_object(
          'recordedThrough',(SELECT to_char(recorded_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM cutoff),
          'partnerLabels',coalesce((SELECT jsonb_object_agg(p.id::text,p.name) FROM hamdee_private.partners p
            JOIN visible_partner_ids v ON v.partner_id=p.id),'{}'::jsonb),
          'partners',coalesce((SELECT jsonb_agg(to_jsonb(p)-'event_id' ORDER BY p.id) FROM
            (SELECT p.* FROM hamdee_private.partners p WHERE ($2::uuid IS NULL OR p.id=$2) AND ($7::uuid IS NULL OR p.id>$7)
              AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM hamdee_private.property_partners l WHERE l.property_id=$1 AND l.partner_id=p.id)) ORDER BY p.id LIMIT $8) p),'[]'::jsonb),
          'links',coalesce((SELECT jsonb_agg(to_jsonb(l)-'event_id' ORDER BY l.id) FROM hamdee_private.property_partners l
            WHERE ($1::uuid IS NULL OR l.property_id=$1) AND ($2::uuid IS NULL OR l.partner_id=$2)),'[]'::jsonb),
          'entries',coalesce((SELECT jsonb_agg(to_jsonb(e)-'event_id'-'amount'||jsonb_build_object('amount',e.amount::text) ORDER BY e.entry_date,e.id) FROM
            (SELECT * FROM eligible WHERE ($6::uuid IS NULL OR (entry_date,id)>($9::date,$6::uuid)) ORDER BY entry_date,id LIMIT $8) e),'[]'::jsonb),
          'history',coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.occurred_at DESC,h.id DESC) FROM history_page h),'[]'::jsonb),
          'summary',coalesce((SELECT jsonb_agg(record ORDER BY property_id,partner_id,currency) FROM grouped_json),'[]'::jsonb),
          'currencies',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.currency) FROM
            (SELECT currency,sum(month_contributions)::text AS "monthContributions",sum(month_withdrawals)::text AS "monthWithdrawals",
              sum(contributions_to_date)::text AS "contributionsToDate",sum(withdrawals_to_date)::text AS "withdrawalsToDate",
              sum(contributions_to_date-withdrawals_to_date)::text AS "recordedNet" FROM groups GROUP BY currency) t),'[]'::jsonb)
        ) AS data`, [propertyId, partnerId, start, through, recordedThrough, entryCursor, partnerCursor, limit + 1, cursorDate])).rows[0].data;
      const { partners, entries, history } = result;
      return { ...result, partners: partners.slice(0, limit).map(dto), entries: entries.slice(0, limit).map(dto), links: result.links.map(dto),
        history: history.slice(0, limit).map(dto), historyHasMore: history.length > limit,
        nextPartnerCursor: partners.length > limit ? String(partners[limit - 1].id) : null,
        nextEntryCursor: entries.length > limit ? Buffer.from(JSON.stringify({ id: entries[limit - 1].id, date: entries[limit - 1].entry_date, recordedThrough: result.recordedThrough, scope })).toString('base64url') : null,
        month: period, asOf, through, moneyUnit:'decimal-major-unit-strings', basis: 'Saved contribution and withdrawal dates, capped at month end and as-of date; entries known by recordedThrough. Recorded net is not profit, entitlement or withdrawal eligibility.' };
    });
  }

  private async existing(sql: Sql, propertyId: string | null, partnerId: string | null) {
    if (propertyId) check((await sql.query('SELECT id FROM hamdee_private.properties WHERE id=$1', [propertyId])).rows.length, 'Property not found.', 'NOT_FOUND', 404);
    if (partnerId) check((await sql.query('SELECT id FROM hamdee_private.partners WHERE id=$1', [partnerId])).rows.length, 'Partner not found.', 'NOT_FOUND', 404);
  }
}
