-- Manually numbered generic PostgreSQL migration, DISPOSABLE LOCAL ONLY.
-- 005 is reserved for independent partner records. Depends on existing 001-004,
-- not on 005. No hosted migration tool or deployment references this file.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'disposable local HAMDEE schema required'; END IF;
END $$;
CREATE TABLE hamdee_private.ops_events(id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
 action text NOT NULL,detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE hamdee_private.ops_collectors(id uuid PRIMARY KEY,name varchar(200) NOT NULL CHECK(length(trim(name))>0),phone varchar(60) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 version integer NOT NULL CHECK(version>0),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.ops_collector_revisions(collector_id uuid NOT NULL REFERENCES hamdee_private.ops_collectors(id) ON DELETE RESTRICT,version integer NOT NULL,
 profile jsonb NOT NULL,event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(collector_id,version));
ALTER TABLE hamdee_private.ops_collectors ADD CONSTRAINT ops_collector_current_revision FOREIGN KEY(id,version)
 REFERENCES hamdee_private.ops_collector_revisions(collector_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.ops_accounts(id uuid PRIMARY KEY,name varchar(200) NOT NULL CHECK(length(trim(name))>0),scope text NOT NULL CHECK(scope IN ('company','personal')),
 kind text NOT NULL CHECK(kind IN ('cash','bank')),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),opening_date date NOT NULL,
 opening_amount numeric NOT NULL CHECK(opening_amount>=0 AND opening_amount<1000000000000000000 AND scale(opening_amount)<=12),
 owner_confirmed boolean NOT NULL CHECK(owner_confirmed),opening_entry_id uuid NOT NULL UNIQUE,notes varchar(2000) NOT NULL DEFAULT '',
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.ops_receipts(id uuid PRIMARY KEY,receipt_key uuid NOT NULL UNIQUE,classification varchar(120) NOT NULL CHECK(length(trim(classification))>0),
 received_date date NOT NULL,amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 method text NOT NULL CHECK(method IN ('cash','bank','cheque')),status text NOT NULL CHECK((method='cheque' AND status='pending') OR (method<>'cheque' AND status='recorded')),
 reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.ops_claims(id uuid PRIMARY KEY,source_kind text NOT NULL CHECK(source_kind IN ('property-rent','car-rental','classified-receipt')),source_id uuid NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(source_kind,source_id));
CREATE TABLE hamdee_private.ops_collections(id uuid PRIMARY KEY,collector_id uuid NOT NULL REFERENCES hamdee_private.ops_collectors(id) ON DELETE RESTRICT,
 claim_id uuid NOT NULL REFERENCES hamdee_private.ops_claims(id) ON DELETE RESTRICT,business_date date NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 method text NOT NULL CHECK(method IN ('cash','bank','cheque')),classification varchar(120) NOT NULL,disposition text NOT NULL CHECK(disposition IN ('collector-held','company-direct','pending')),
 account_id uuid REFERENCES hamdee_private.ops_accounts(id) ON DELETE RESTRICT,owner_confirmed boolean NOT NULL,
 notes varchar(2000) NOT NULL DEFAULT '',event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((disposition='company-direct' AND account_id IS NOT NULL) OR (disposition<>'company-direct' AND account_id IS NULL)));
CREATE TABLE hamdee_private.ops_collection_reversals(id uuid PRIMARY KEY,collection_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_collections(id) ON DELETE RESTRICT,
 reversed_date date NOT NULL,reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.ops_transfers(id uuid PRIMARY KEY,collector_id uuid REFERENCES hamdee_private.ops_collectors(id) ON DELETE RESTRICT,
 from_account_id uuid REFERENCES hamdee_private.ops_accounts(id) ON DELETE RESTRICT,to_account_id uuid NOT NULL REFERENCES hamdee_private.ops_accounts(id) ON DELETE RESTRICT,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),business_date date NOT NULL,
 reference varchar(200) NOT NULL CHECK(length(trim(reference))>0),notes varchar(2000) NOT NULL DEFAULT '',replaces_id uuid REFERENCES hamdee_private.ops_transfers(id) ON DELETE RESTRICT,
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((collector_id IS NOT NULL AND from_account_id IS NULL) OR (collector_id IS NULL AND from_account_id IS NOT NULL AND from_account_id<>to_account_id)));
CREATE UNIQUE INDEX ops_handover_reference ON hamdee_private.ops_transfers(collector_id,reference) WHERE collector_id IS NOT NULL;
CREATE UNIQUE INDEX ops_account_transfer_reference ON hamdee_private.ops_transfers(from_account_id,reference) WHERE from_account_id IS NOT NULL;
CREATE TABLE hamdee_private.ops_money(id uuid PRIMARY KEY,location_type text NOT NULL CHECK(location_type IN ('account','collector')),
 collector_id uuid REFERENCES hamdee_private.ops_collectors(id) ON DELETE RESTRICT,account_id uuid REFERENCES hamdee_private.ops_accounts(id) ON DELETE RESTRICT,
 business_date date NOT NULL,delta numeric NOT NULL CHECK(abs(delta)<1000000000000000000 AND scale(delta)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 method text NOT NULL CHECK(method IN ('cash','bank')),entry_kind text NOT NULL CHECK(entry_kind IN ('opening','receipt','collection','expense','handover-in','handover-out','transfer-in','transfer-out','reversal')),
 classification varchar(120) NOT NULL,claim_id uuid REFERENCES hamdee_private.ops_claims(id) ON DELETE RESTRICT,collection_id uuid REFERENCES hamdee_private.ops_collections(id) ON DELETE RESTRICT,
 transfer_id uuid REFERENCES hamdee_private.ops_transfers(id) ON DELETE RESTRICT,reversal_of uuid UNIQUE REFERENCES hamdee_private.ops_money(id) ON DELETE RESTRICT,
 reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((location_type='account' AND account_id IS NOT NULL AND collector_id IS NULL) OR (location_type='collector' AND collector_id IS NOT NULL AND account_id IS NULL)),
 CHECK((entry_kind='opening' AND delta>=0) OR (entry_kind IN ('receipt','collection','handover-in','transfer-in') AND delta>0)
 OR (entry_kind IN ('expense','handover-out','transfer-out') AND delta<0) OR (entry_kind='reversal' AND delta<>0)),
 CHECK((entry_kind='reversal')=(reversal_of IS NOT NULL)),CHECK((entry_kind IN ('handover-in','handover-out','transfer-in','transfer-out')) OR entry_kind='reversal' OR transfer_id IS NULL));
ALTER TABLE hamdee_private.ops_accounts ADD CONSTRAINT ops_opening_evidence FOREIGN KEY(opening_entry_id) REFERENCES hamdee_private.ops_money(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.ops_expense_keys(id uuid PRIMARY KEY,entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) ON DELETE RESTRICT,
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.ops_commands(actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,key uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),result jsonb NOT NULL,event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(actor_id,key));
CREATE INDEX ops_money_account_date ON hamdee_private.ops_money(account_id,currency,business_date,id);
CREATE INDEX ops_money_collector_date ON hamdee_private.ops_money(collector_id,currency,business_date,id);
CREATE INDEX ops_money_claim ON hamdee_private.ops_money(claim_id);CREATE INDEX ops_money_transfer ON hamdee_private.ops_money(transfer_id);
CREATE INDEX ops_money_collection ON hamdee_private.ops_money(collection_id);CREATE INDEX ops_collections_claim ON hamdee_private.ops_collections(claim_id);
CREATE INDEX ops_collections_collector ON hamdee_private.ops_collections(collector_id,currency,business_date);
CREATE INDEX ops_transfers_target ON hamdee_private.ops_transfers(to_account_id);
CREATE INDEX ops_events_actor ON hamdee_private.ops_events(actor_id,occurred_at);

-- Reassigning a reversed receipt must not recreate custody before its reversal
-- date. Original source date stays in the immutable claim snapshot.
CREATE FUNCTION hamdee_private.ops_claim_placement_date(claim uuid,source_date date) RETURNS date LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT greatest(source_date,coalesce(max(d),'1900-01-01'::date)) FROM(
  SELECT r.reversed_date AS d FROM hamdee_private.ops_collection_reversals r JOIN hamdee_private.ops_collections c ON c.id=r.collection_id WHERE c.claim_id=claim
  UNION ALL SELECT m.business_date FROM hamdee_private.ops_money m WHERE m.claim_id=claim AND m.entry_kind='reversal') changes
$$;
REVOKE ALL ON FUNCTION hamdee_private.ops_claim_placement_date(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.ops_claim_placement_date(uuid,date) TO hamdee_runtime;

CREATE FUNCTION hamdee_private.guard_ops_collector() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.version<>OLD.version+1 OR NEW.event_id=OLD.event_id)) THEN RAISE EXCEPTION 'collector revision required'; END IF;
 RETURN NEW;END $$;
CREATE TRIGGER ops_collector_change BEFORE INSERT OR UPDATE ON hamdee_private.ops_collectors FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_ops_collector();
CREATE FUNCTION hamdee_private.check_ops_collector() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.ops_collector_revisions r WHERE r.collector_id=NEW.id AND r.version=NEW.version AND r.event_id=NEW.event_id AND r.profile=to_jsonb(NEW)-'event_id') THEN RAISE EXCEPTION 'matching collector snapshot required'; END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER ops_collector_snapshot AFTER INSERT OR UPDATE ON hamdee_private.ops_collectors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_ops_collector();
CREATE FUNCTION hamdee_private.check_ops_account() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.ops_money m WHERE m.id=NEW.opening_entry_id AND m.account_id=NEW.id AND m.entry_kind='opening'
  AND m.delta=NEW.opening_amount AND m.currency=NEW.currency AND m.business_date=NEW.opening_date AND m.method=NEW.kind AND m.event_id=NEW.event_id)
 THEN RAISE EXCEPTION 'matching confirmed account opening required';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER ops_account_opening AFTER INSERT ON hamdee_private.ops_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_ops_account();
CREATE FUNCTION hamdee_private.guard_ops_collection() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));SELECT snapshot INTO s FROM hamdee_private.ops_claims WHERE id=NEW.claim_id;
 IF s IS NULL OR NEW.amount<>(s->>'amount')::numeric OR NEW.currency<>s->>'currency' OR NEW.business_date<>hamdee_private.ops_claim_placement_date(NEW.claim_id,(s->>'date')::date) OR NEW.method<>s->>'method' OR NEW.classification<>s->>'classification'
 THEN RAISE EXCEPTION 'authoritative receipt snapshot required'; END IF;
 IF EXISTS(SELECT 1 FROM hamdee_private.ops_collections c WHERE c.claim_id=NEW.claim_id AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_collection_reversals r WHERE r.collection_id=c.id)) THEN RAISE EXCEPTION 'duplicate active collection'; END IF;
 IF ((s->>'status'='pending' OR s->>'method'='cheque') AND NEW.disposition<>'pending') OR ((s->>'status'='recorded' AND s->>'method'<>'cheque') AND NEW.disposition='pending') THEN RAISE EXCEPTION 'pending receipt is not available cash'; END IF;
 IF s->>'disposition'='unassigned' AND NEW.disposition<>'pending' AND NOT NEW.owner_confirmed THEN RAISE EXCEPTION 'actual custody confirmation required'; END IF;
 IF s->>'disposition'='company-direct' AND NEW.disposition<>'company-direct' THEN RAISE EXCEPTION 'direct company receipt is not collector custody'; END IF;
 IF NEW.disposition='company-direct' AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_accounts a WHERE a.id=NEW.account_id AND a.scope='company' AND a.currency=NEW.currency AND a.owner_confirmed) THEN RAISE EXCEPTION 'confirmed company account required'; END IF;
 RETURN NEW;END $$;
CREATE TRIGGER ops_collection_source BEFORE INSERT ON hamdee_private.ops_collections FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_ops_collection();
CREATE FUNCTION hamdee_private.guard_ops_money() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a hamdee_private.ops_accounts;c hamdee_private.ops_collections;s jsonb;o hamdee_private.ops_money;t hamdee_private.ops_transfers;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF NEW.account_id IS NOT NULL THEN SELECT * INTO a FROM hamdee_private.ops_accounts WHERE id=NEW.account_id;
  IF a.id IS NULL OR a.currency<>NEW.currency OR NEW.business_date<a.opening_date THEN RAISE EXCEPTION 'same currency account and opening date required'; END IF;END IF;
 IF NEW.entry_kind='opening' THEN
  IF a.id IS NULL OR a.opening_entry_id<>NEW.id OR a.opening_amount<>NEW.delta OR a.opening_date<>NEW.business_date OR a.kind<>NEW.method THEN RAISE EXCEPTION 'confirmed matching opening required'; END IF;
 ELSIF NEW.entry_kind IN ('collection','receipt') THEN
  SELECT snapshot INTO s FROM hamdee_private.ops_claims WHERE id=NEW.claim_id;
  IF s IS NULL OR NEW.delta<>(s->>'amount')::numeric OR NEW.currency<>s->>'currency' OR NEW.business_date<>hamdee_private.ops_claim_placement_date(NEW.claim_id,(s->>'date')::date) OR NEW.method<>s->>'method' OR NEW.classification<>s->>'classification'
    OR s->>'status'<>'recorded' OR s->>'method'='cheque' THEN RAISE EXCEPTION 'available authoritative receipt required'; END IF;
  IF EXISTS(SELECT 1 FROM hamdee_private.ops_money m WHERE m.claim_id=NEW.claim_id AND m.entry_kind IN ('collection','receipt') AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_money r WHERE r.reversal_of=m.id)) THEN RAISE EXCEPTION 'source already placed'; END IF;
  IF NEW.entry_kind='collection' THEN SELECT * INTO c FROM hamdee_private.ops_collections WHERE id=NEW.collection_id;
   IF c.id IS NULL OR c.disposition<>'collector-held' OR c.collector_id IS DISTINCT FROM NEW.collector_id OR c.claim_id<>NEW.claim_id OR NEW.location_type<>'collector' THEN RAISE EXCEPTION 'matching collector custody required'; END IF;
  ELSIF NEW.location_type<>'account' THEN RAISE EXCEPTION 'account receipt required';END IF;
 ELSIF NEW.entry_kind='expense' THEN
  IF NEW.location_type<>'account' OR NEW.claim_id IS NOT NULL OR NEW.collection_id IS NOT NULL OR NEW.transfer_id IS NOT NULL THEN RAISE EXCEPTION 'explicit account expense required';END IF;
 ELSIF NEW.entry_kind='reversal' THEN SELECT * INTO o FROM hamdee_private.ops_money WHERE id=NEW.reversal_of;
  IF o.id IS NULL OR o.entry_kind IN ('opening','reversal') OR NEW.business_date<o.business_date OR
   ROW(NEW.delta,NEW.location_type,NEW.account_id,NEW.collector_id,NEW.currency,NEW.method,NEW.claim_id,NEW.collection_id,NEW.transfer_id,NEW.classification)
   IS DISTINCT FROM ROW(-o.delta,o.location_type,o.account_id,o.collector_id,o.currency,o.method,o.claim_id,o.collection_id,o.transfer_id,o.classification) THEN RAISE EXCEPTION 'exact linked reversal required';END IF;
 ELSE SELECT * INTO t FROM hamdee_private.ops_transfers WHERE id=NEW.transfer_id;
  IF t.id IS NULL OR abs(NEW.delta)<>t.amount OR NEW.currency<>t.currency OR NEW.business_date<>t.business_date OR NEW.reference<>t.reference OR NEW.event_id<>t.event_id THEN RAISE EXCEPTION 'matching transfer required'; END IF;
  IF t.collector_id IS NOT NULL AND NEW.account_id IS NOT NULL AND a.scope<>'company' THEN RAISE EXCEPTION 'handover requires company account';END IF;
  IF (NEW.entry_kind='handover-out' AND (NEW.location_type<>'collector' OR NEW.collector_id IS DISTINCT FROM t.collector_id))
   OR (NEW.entry_kind='transfer-out' AND (NEW.location_type<>'account' OR NEW.account_id IS DISTINCT FROM t.from_account_id))
   OR (NEW.entry_kind IN ('handover-in','transfer-in') AND (NEW.location_type<>'account' OR NEW.account_id<>t.to_account_id)) THEN RAISE EXCEPTION 'transfer location mismatch';END IF;
 END IF;
 RETURN NEW;END $$;
CREATE TRIGGER ops_money_guard BEFORE INSERT ON hamdee_private.ops_money FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_ops_money();
CREATE FUNCTION hamdee_private.check_ops_money() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE n integer;r integer;total numeric;BEGIN
 IF EXISTS(SELECT 1 FROM(SELECT sum(daily) OVER(PARTITION BY location_type,location_id,currency ORDER BY business_date) AS balance FROM
 (SELECT location_type,coalesce(account_id,collector_id) AS location_id,currency,business_date,sum(delta) AS daily FROM hamdee_private.ops_money GROUP BY location_type,coalesce(account_id,collector_id),currency,business_date) d) b WHERE balance<0) THEN RAISE EXCEPTION 'negative daily recorded custody/account funds';END IF;
 IF NEW.transfer_id IS NOT NULL THEN
  SELECT count(*) FILTER(WHERE entry_kind<>'reversal'),count(*) FILTER(WHERE entry_kind='reversal'),sum(delta) INTO n,r,total FROM hamdee_private.ops_money WHERE transfer_id=NEW.transfer_id;
  IF n<>2 OR r NOT IN(0,2) OR total<>0 THEN RAISE EXCEPTION 'complete balanced transfer and reversal pair required';END IF;
  IF r=2 AND (SELECT count(DISTINCT (event_id,business_date)) FROM hamdee_private.ops_money WHERE transfer_id=NEW.transfer_id AND entry_kind='reversal')<>1 THEN RAISE EXCEPTION 'atomic transfer reversal required';END IF;
 END IF;
 IF NEW.entry_kind='expense' AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_expense_keys k WHERE k.entry_id=NEW.id AND k.event_id=NEW.event_id) THEN RAISE EXCEPTION 'stable expense identity required';END IF;
 RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER ops_money_evidence AFTER INSERT ON hamdee_private.ops_money DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_ops_money();
CREATE FUNCTION hamdee_private.check_ops_collection_reversal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c hamdee_private.ops_collections;BEGIN
 SELECT * INTO c FROM hamdee_private.ops_collections WHERE id=NEW.collection_id;
 IF NEW.reversed_date<c.business_date OR (c.disposition='collector-held' AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_money r JOIN hamdee_private.ops_money o ON o.id=r.reversal_of
   WHERE o.collection_id=c.id AND o.entry_kind='collection' AND r.business_date=NEW.reversed_date AND r.event_id=NEW.event_id)) THEN RAISE EXCEPTION 'matching collection reversal required';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER ops_collection_reversal_evidence AFTER INSERT ON hamdee_private.ops_collection_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_ops_collection_reversal();

DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ops_events','ops_collectors','ops_collector_revisions','ops_accounts','ops_receipts','ops_claims','ops_collections','ops_collection_reversals','ops_transfers','ops_money','ops_expense_keys','ops_commands'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY ops_owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
  EXECUTE format('CREATE POLICY ops_owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
  EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  IF t='ops_collectors' THEN
   EXECUTE format('CREATE POLICY ops_owner_update ON hamdee_private.%I FOR UPDATE TO hamdee_runtime USING(hamdee_private.rental_owner()) WITH CHECK(hamdee_private.rental_owner())',t);
   EXECUTE format('CREATE TRIGGER immutable_delete BEFORE DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
  ELSE EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);END IF;
 END LOOP;
END $$;
DROP POLICY ops_owner_insert ON hamdee_private.ops_events;
CREATE POLICY ops_owner_insert ON hamdee_private.ops_events FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
DROP POLICY ops_owner_insert ON hamdee_private.ops_commands;
CREATE POLICY ops_owner_insert ON hamdee_private.ops_commands FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
GRANT UPDATE(name,phone,notes,version,event_id) ON hamdee_private.ops_collectors TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.guard_ops_collector(),hamdee_private.check_ops_collector(),hamdee_private.check_ops_account(),hamdee_private.guard_ops_collection(),hamdee_private.guard_ops_money(),hamdee_private.check_ops_money(),hamdee_private.check_ops_collection_reversal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_ops_collector(),hamdee_private.check_ops_collector(),hamdee_private.check_ops_account(),hamdee_private.guard_ops_collection(),hamdee_private.guard_ops_money(),hamdee_private.check_ops_money(),hamdee_private.check_ops_collection_reversal() TO hamdee_runtime;
