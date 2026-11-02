-- Additive local-only principal and supporting-reference records. Not hosted execution authority.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.ops_money') IS NULL THEN RAISE EXCEPTION 'local HAMDEE money schema required';END IF;
END $$;
CREATE TABLE hamdee_private.principal_obligations(
 id uuid PRIMARY KEY,direction text NOT NULL CHECK(direction IN ('receivable','payable')),
 kind text NOT NULL CHECK(kind IN ('loan','receivable','arrears','reimbursement','other')),
 counterparty varchar(200) NOT NULL CHECK(length(trim(counterparty))>0),customer_id uuid REFERENCES hamdee_private.tenants(id),
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 opened_date date NOT NULL,reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hamdee_private.principal_amendments(
 id uuid PRIMARY KEY,obligation_id uuid NOT NULL REFERENCES hamdee_private.principal_obligations(id),version integer NOT NULL CHECK(version>1),
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),business_date date NOT NULL,reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(obligation_id,version)
);
CREATE TABLE hamdee_private.principal_movements(
 id uuid PRIMARY KEY,obligation_id uuid NOT NULL REFERENCES hamdee_private.principal_obligations(id),kind text NOT NULL CHECK(kind IN ('funding','repayment')),
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),business_date date NOT NULL,
 method text NOT NULL CHECK(method IN ('cash','bank')),account_id uuid REFERENCES hamdee_private.ops_accounts(id),collector_id uuid REFERENCES hamdee_private.ops_collectors(id),
 money_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) DEFERRABLE INITIALLY DEFERRED,
 reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 replaces_id uuid UNIQUE REFERENCES hamdee_private.principal_movements(id),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(num_nonnulls(account_id,collector_id)=1)
);
CREATE TABLE hamdee_private.principal_corrections(
 id uuid PRIMARY KEY,movement_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.principal_movements(id),business_date date NOT NULL,
 reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),reversal_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) DEFERRABLE INITIALLY DEFERRED,
 replacement_id uuid UNIQUE REFERENCES hamdee_private.principal_movements(id) DEFERRABLE INITIALLY DEFERRED,
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX principal_customer ON hamdee_private.principal_obligations(customer_id,opened_date,currency);
CREATE INDEX principal_movement_date ON hamdee_private.principal_movements(obligation_id,business_date);
CREATE TABLE hamdee_private.supporting_records(
 id uuid NOT NULL,version integer NOT NULL CHECK(version>0),kind text NOT NULL CHECK(kind IN ('landlord-terms','utility-account','utility-schedule','policy','investment','asset','other-reference')),
 label varchar(200) NOT NULL CHECK(length(trim(label))>0),property_id uuid REFERENCES hamdee_private.properties(id),room_id uuid,
 vehicle_id uuid REFERENCES hamdee_private.car_vehicles(id),customer_id uuid REFERENCES hamdee_private.tenants(id),
 source_reference varchar(500) NOT NULL DEFAULT '',original_wording varchar(2000) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),review_questions jsonb NOT NULL CHECK(jsonb_typeof(review_questions)='array'),
 status text NOT NULL CHECK(status IN ('unconfirmed','owner-confirmed')),reason varchar(2000) NOT NULL DEFAULT '',
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(id,version),FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id)
);
CREATE TABLE hamdee_private.supporting_expense_links(
 expense_id uuid PRIMARY KEY REFERENCES hamdee_private.property_expenses(id),record_id uuid NOT NULL,record_version integer NOT NULL,
 reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(record_id,record_version) REFERENCES hamdee_private.supporting_records(id,version)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['principal_obligations','principal_amendments','principal_movements','principal_corrections','supporting_records','supporting_expense_links'] LOOP
 EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
 EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
 EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
 END LOOP;
END $$;
CREATE FUNCTION hamdee_private.guard_principal_money() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM hamdee_private.principal_movements WHERE money_entry_id=NEW.reversal_of)
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_corrections c JOIN hamdee_private.principal_movements m ON m.id=c.movement_id WHERE m.money_entry_id=NEW.reversal_of AND c.reversal_entry_id=NEW.id AND c.business_date=NEW.business_date AND c.event_id=NEW.event_id)
 THEN RAISE EXCEPTION 'principal movement requires linked correction';END IF;
 IF NEW.entry_kind IN ('receipt','collection') AND EXISTS(SELECT 1 FROM hamdee_private.principal_movements p JOIN hamdee_private.ops_money original ON original.id=p.money_entry_id JOIN hamdee_private.principal_corrections c ON c.movement_id=p.id WHERE original.claim_id=NEW.claim_id)
 THEN RAISE EXCEPTION 'corrected principal receipt cannot be received again';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER principal_money_correction AFTER INSERT ON hamdee_private.ops_money DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_principal_money();
-- Add principal payouts to the existing collector evidence guard without weakening bill evidence.
CREATE OR REPLACE FUNCTION hamdee_private.check_collector_expense_funding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.entry_kind='expense' AND NEW.location_type='collector'
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.expense_funding_links WHERE entry_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_movements WHERE money_entry_id=NEW.id)
 THEN RAISE EXCEPTION 'collector spending requires linked source evidence';END IF;RETURN NULL;
END $$;
CREATE FUNCTION hamdee_private.check_principal_movement() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE o hamdee_private.principal_obligations;m hamdee_private.ops_money;incoming boolean;BEGIN
 SELECT * INTO o FROM hamdee_private.principal_obligations WHERE id=NEW.obligation_id;
 SELECT * INTO m FROM hamdee_private.ops_money WHERE id=NEW.money_entry_id;
 incoming := (o.direction='receivable' AND NEW.kind='repayment') OR (o.direction='payable' AND NEW.kind='funding');
 IF m.id IS NULL OR m.delta<>(CASE WHEN incoming THEN NEW.amount ELSE -NEW.amount END) OR m.currency<>o.currency OR m.business_date<>NEW.business_date
 OR m.account_id IS DISTINCT FROM NEW.account_id OR m.collector_id IS DISTINCT FROM NEW.collector_id OR m.method<>NEW.method OR m.event_id<>NEW.event_id
 OR NEW.business_date<o.opened_date OR m.classification<>'principal-'||NEW.kind THEN RAISE EXCEPTION 'exact dated principal money evidence required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER principal_movement_evidence AFTER INSERT ON hamdee_private.principal_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_principal_movement();
REVOKE ALL ON FUNCTION hamdee_private.guard_principal_money(),hamdee_private.check_principal_movement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_principal_money(),hamdee_private.check_principal_movement() TO hamdee_runtime;
CREATE FUNCTION hamdee_private.check_principal_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE oid uuid;original hamdee_private.principal_movements;replacement hamdee_private.principal_movements;reversal hamdee_private.ops_money;previous hamdee_private.principal_amendments;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF TG_TABLE_NAME='principal_corrections' THEN
  SELECT * INTO original FROM hamdee_private.principal_movements WHERE id=NEW.movement_id;oid:=original.obligation_id;
  SELECT * INTO reversal FROM hamdee_private.ops_money WHERE id=NEW.reversal_entry_id;
  IF NEW.business_date<original.business_date OR reversal.reversal_of IS DISTINCT FROM original.money_entry_id OR reversal.event_id IS DISTINCT FROM NEW.event_id OR reversal.business_date IS DISTINCT FROM NEW.business_date THEN RAISE EXCEPTION 'matching original principal reversal required';END IF;
  IF NEW.replacement_id IS NOT NULL THEN
   SELECT * INTO replacement FROM hamdee_private.principal_movements WHERE id=NEW.replacement_id;
   IF replacement.id IS NULL OR replacement.obligation_id<>oid OR replacement.kind<>original.kind OR replacement.replaces_id IS DISTINCT FROM original.id OR replacement.business_date<NEW.business_date OR replacement.event_id<>NEW.event_id THEN RAISE EXCEPTION 'matching dated principal replacement required';END IF;
  END IF;
 ELSE oid:=NEW.obligation_id;END IF;
 IF TG_TABLE_NAME='principal_amendments' THEN
  SELECT * INTO previous FROM hamdee_private.principal_amendments WHERE obligation_id=oid AND id<>NEW.id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(previous.version,1)+1 OR NEW.business_date<coalesce(previous.business_date,(SELECT opened_date FROM hamdee_private.principal_obligations WHERE id=oid)) THEN RAISE EXCEPTION 'sequential dated principal confirmation required';END IF;
 END IF;
 IF EXISTS(WITH dates AS(SELECT opened_date AS d FROM hamdee_private.principal_obligations WHERE id=oid UNION SELECT business_date FROM hamdee_private.principal_amendments WHERE obligation_id=oid UNION SELECT business_date FROM hamdee_private.principal_movements WHERE obligation_id=oid UNION SELECT c.business_date FROM hamdee_private.principal_corrections c JOIN hamdee_private.principal_movements m ON m.id=c.movement_id WHERE m.obligation_id=oid)
  SELECT 1 FROM dates d JOIN hamdee_private.principal_obligations o ON o.id=oid WHERE coalesce((SELECT amount FROM hamdee_private.principal_amendments a WHERE a.obligation_id=o.id AND a.business_date<=d.d ORDER BY version DESC LIMIT 1),o.amount)<coalesce((SELECT sum(m.amount) FROM hamdee_private.principal_movements m WHERE m.obligation_id=o.id AND m.kind='repayment' AND m.business_date<=d.d AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_corrections c WHERE c.movement_id=m.id AND c.business_date<=d.d)),0))
 THEN RAISE EXCEPTION 'dated repayment exceeds principal';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER principal_balance AFTER INSERT ON hamdee_private.principal_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_principal_integrity();
CREATE CONSTRAINT TRIGGER principal_amendment_balance AFTER INSERT ON hamdee_private.principal_amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_principal_integrity();
CREATE CONSTRAINT TRIGGER principal_correction_balance AFTER INSERT ON hamdee_private.principal_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_principal_integrity();
REVOKE ALL ON FUNCTION hamdee_private.check_principal_integrity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_principal_integrity() TO hamdee_runtime;
