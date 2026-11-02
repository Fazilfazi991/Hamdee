-- Additive disposable-local candidate. Applied migration013 identity must be inspected
-- before a separate hosted wrapper is prepared; no old migration is rewritten.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.expense_funding_links') IS NULL OR to_regclass('hamdee_private.security_deposit_refunds') IS NULL
 THEN RAISE EXCEPTION 'local candidate corrections dependencies required';END IF;
END $$;
CREATE TABLE hamdee_private.rental_refund_funding_links(
 collection_id uuid PRIMARY KEY REFERENCES hamdee_private.rent_collections(id),entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hamdee_private.rental_refund_funding_links ENABLE ROW LEVEL SECURITY;ALTER TABLE hamdee_private.rental_refund_funding_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.rental_refund_funding_links FROM PUBLIC;GRANT SELECT,INSERT ON hamdee_private.rental_refund_funding_links TO hamdee_runtime;
CREATE POLICY owner_read ON hamdee_private.rental_refund_funding_links FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
CREATE POLICY owner_insert ON hamdee_private.rental_refund_funding_links FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner());
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.rental_refund_funding_links FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
CREATE FUNCTION hamdee_private.check_rental_refund_funding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r hamdee_private.rent_collections;m hamdee_private.ops_money;BEGIN
 SELECT * INTO r FROM hamdee_private.rent_collections WHERE id=NEW.collection_id;SELECT * INTO m FROM hamdee_private.ops_money WHERE id=NEW.entry_id;
 IF r.kind<>'deposit_refund' OR r.status<>'recorded' OR m.entry_kind<>'expense' OR m.delta<>-r.amount_minor::numeric/100 OR m.currency<>r.currency OR m.method<>r.method OR m.business_date<>r.received_date OR m.event_id<>NEW.event_id
 THEN RAISE EXCEPTION 'exact funded rental refund required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rental_refund_funding_evidence AFTER INSERT ON hamdee_private.rental_refund_funding_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_rental_refund_funding();
REVOKE ALL ON FUNCTION hamdee_private.check_rental_refund_funding() FROM PUBLIC;GRANT EXECUTE ON FUNCTION hamdee_private.check_rental_refund_funding() TO hamdee_runtime;
CREATE TABLE hamdee_private.financial_corrections(
 id uuid PRIMARY KEY,source_kind text NOT NULL CHECK(source_kind IN ('expense-payment','rental-refund','security-refund')),
 source_id uuid NOT NULL,corrected_date date NOT NULL,original_amount_minor bigint NOT NULL CHECK(original_amount_minor>0),
 money_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id),
 reversal_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) DEFERRABLE INITIALLY DEFERRED,
 replacement_id uuid,reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(source_kind,source_id)
);
ALTER TABLE hamdee_private.financial_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.financial_corrections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.financial_corrections FROM PUBLIC;
GRANT SELECT,INSERT ON hamdee_private.financial_corrections TO hamdee_runtime;
CREATE POLICY owner_read ON hamdee_private.financial_corrections FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
CREATE POLICY owner_insert ON hamdee_private.financial_corrections FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.financial_corrections FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();

CREATE VIEW hamdee_private.expense_payment_effects WITH(security_invoker=true) AS
 SELECT p.*,NULL::uuid AS correction_of FROM hamdee_private.expense_payments p
 UNION ALL SELECT c.id,p.expense_id,p.property_id,p.method,-p.amount_minor,c.corrected_date,p.reference,p.status,c.event_id,p.id
 FROM hamdee_private.financial_corrections c JOIN hamdee_private.expense_payments p ON p.id=c.source_id WHERE c.source_kind='expense-payment';
CREATE VIEW hamdee_private.rental_collection_effects WITH(security_invoker=true) AS
 SELECT r.*,NULL::uuid AS correction_of FROM hamdee_private.rent_collections r
 UNION ALL SELECT c.id,r.agreement_id,r.room_id,r.property_id,r.currency,r.kind,r.method,-r.amount_minor,c.corrected_date,r.reference,r.status,c.event_id,r.id
 FROM hamdee_private.financial_corrections c JOIN hamdee_private.rent_collections r ON r.id=c.source_id WHERE c.source_kind='rental-refund';
CREATE VIEW hamdee_private.security_deposit_refund_effects WITH(security_invoker=true) AS
 SELECT r.*,NULL::uuid AS correction_of FROM hamdee_private.security_deposit_refunds r
 UNION ALL SELECT c.id,r.cheque_id,-r.amount_minor,c.corrected_date,c.reason,c.reversal_entry_id,c.event_id,r.id
 FROM hamdee_private.financial_corrections c JOIN hamdee_private.security_deposit_refunds r ON r.id=c.source_id WHERE c.source_kind='security-refund';
REVOKE ALL ON hamdee_private.expense_payment_effects,hamdee_private.rental_collection_effects,hamdee_private.security_deposit_refund_effects FROM PUBLIC;
GRANT SELECT ON hamdee_private.expense_payment_effects,hamdee_private.rental_collection_effects,hamdee_private.security_deposit_refund_effects TO hamdee_runtime;

-- A replacement may retain the original bank reference. Ordinary duplicate
-- payment references remain denied; the exception follows explicit ancestry.
DROP INDEX hamdee_private.expense_payment_reference;
CREATE FUNCTION hamdee_private.guard_corrected_expense_reference() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('expense-payment:'||NEW.expense_id::text,0));
 IF length(trim(NEW.reference))>0 AND EXISTS(
  WITH RECURSIVE ancestors(id) AS(
   SELECT source_id FROM hamdee_private.financial_corrections WHERE source_kind='expense-payment' AND replacement_id=NEW.id
   UNION ALL SELECT c.source_id FROM hamdee_private.financial_corrections c JOIN ancestors a ON c.replacement_id=a.id WHERE c.source_kind='expense-payment')
  SELECT 1 FROM hamdee_private.expense_payments p WHERE p.expense_id=NEW.expense_id AND p.method=NEW.method AND upper(trim(p.reference))=upper(trim(NEW.reference)) AND NOT EXISTS(SELECT 1 FROM ancestors a WHERE a.id=p.id))
 THEN RAISE EXCEPTION 'duplicate expense payment reference';END IF;RETURN NEW;
END $$;
CREATE TRIGGER corrected_expense_reference_guard BEFORE INSERT ON hamdee_private.expense_payments FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_corrected_expense_reference();
REVOKE ALL ON FUNCTION hamdee_private.guard_corrected_expense_reference() FROM PUBLIC;GRANT EXECUTE ON FUNCTION hamdee_private.guard_corrected_expense_reference() TO hamdee_runtime;

CREATE OR REPLACE FUNCTION hamdee_private.guard_expense_payment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE cost bigint;paid numeric;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('expense-payment:'||NEW.expense_id::text,0));
 SELECT amount_minor INTO cost FROM hamdee_private.property_expenses WHERE id=NEW.expense_id AND property_id IS NOT DISTINCT FROM NEW.property_id;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM hamdee_private.expense_payment_effects WHERE expense_id=NEW.expense_id AND status='recorded';
 IF cost IS NULL OR NEW.amount_minor+paid>cost THEN RAISE EXCEPTION 'payment exceeds unpaid expense';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hamdee_private.guard_funded_expense_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reversal_of IS NOT NULL AND (EXISTS(SELECT 1 FROM hamdee_private.expense_funding_links WHERE entry_id=NEW.reversal_of) OR EXISTS(SELECT 1 FROM hamdee_private.rental_refund_funding_links WHERE entry_id=NEW.reversal_of))
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.financial_corrections c WHERE c.source_kind IN ('expense-payment','rental-refund') AND c.money_entry_id=NEW.reversal_of AND c.reversal_entry_id=NEW.id AND c.event_id=NEW.event_id AND c.corrected_date=NEW.business_date)
 THEN RAISE EXCEPTION 'linked bill payment requires a coordinated expense correction';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hamdee_private.check_security_deposit_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE original_cheque uuid;BEGIN
 IF NEW.reversal_of IS NULL THEN RETURN NULL;END IF;
 SELECT cheque_id INTO original_cheque FROM hamdee_private.security_cheque_events WHERE money_entry_id=NEW.reversal_of;
 IF original_cheque IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hamdee_private.security_cheque_events WHERE cheque_id=original_cheque AND reversal_entry_id=NEW.id AND status='bounced' AND business_date=NEW.business_date)
 THEN RAISE EXCEPTION 'explicit linked security cheque correction required';END IF;
 IF EXISTS(SELECT 1 FROM hamdee_private.security_deposit_refunds WHERE money_entry_id=NEW.reversal_of)
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.financial_corrections c WHERE c.source_kind='security-refund' AND c.money_entry_id=NEW.reversal_of AND c.reversal_entry_id=NEW.id AND c.event_id=NEW.event_id AND c.corrected_date=NEW.business_date)
 THEN RAISE EXCEPTION 'deposit refund requires linked correction';END IF;RETURN NULL;
END $$;
CREATE FUNCTION hamdee_private.check_financial_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE original hamdee_private.ops_money;reversal hamdee_private.ops_money;amount bigint;source_entry uuid;parent uuid;replacement_parent uuid;replacement_event uuid;BEGIN
 SELECT * INTO original FROM hamdee_private.ops_money WHERE id=NEW.money_entry_id;
 SELECT * INTO reversal FROM hamdee_private.ops_money WHERE id=NEW.reversal_entry_id;
 IF NEW.source_kind='expense-payment' THEN SELECT p.amount_minor,l.entry_id INTO amount,source_entry FROM hamdee_private.expense_payments p JOIN hamdee_private.expense_funding_links l ON l.payment_id=p.id WHERE p.id=NEW.source_id AND p.status='recorded';
 ELSIF NEW.source_kind='security-refund' THEN SELECT amount_minor,money_entry_id INTO amount,source_entry FROM hamdee_private.security_deposit_refunds WHERE id=NEW.source_id;
 ELSE SELECT r.amount_minor,l.entry_id INTO amount,source_entry FROM hamdee_private.rent_collections r JOIN hamdee_private.rental_refund_funding_links l ON l.collection_id=r.id WHERE r.id=NEW.source_id AND r.kind='deposit_refund' AND r.status='recorded';END IF;
 IF amount IS NULL OR amount<>NEW.original_amount_minor OR source_entry IS DISTINCT FROM NEW.money_entry_id OR original.entry_kind<>'expense' OR original.delta<>-amount::numeric/100
 OR reversal.reversal_of IS DISTINCT FROM original.id OR reversal.business_date<>NEW.corrected_date OR reversal.event_id<>NEW.event_id OR reversal.delta<>-original.delta
 THEN RAISE EXCEPTION 'exact source and linked money correction required';END IF;
 IF NEW.replacement_id IS NOT NULL THEN
  IF NEW.source_kind='expense-payment' THEN SELECT expense_id INTO parent FROM hamdee_private.expense_payments WHERE id=NEW.source_id;SELECT expense_id,event_id INTO replacement_parent,replacement_event FROM hamdee_private.expense_payments WHERE id=NEW.replacement_id;
  ELSIF NEW.source_kind='rental-refund' THEN SELECT agreement_id INTO parent FROM hamdee_private.rent_collections WHERE id=NEW.source_id;SELECT agreement_id,event_id INTO replacement_parent,replacement_event FROM hamdee_private.rent_collections WHERE id=NEW.replacement_id AND kind='deposit_refund';
  ELSE SELECT cheque_id INTO parent FROM hamdee_private.security_deposit_refunds WHERE id=NEW.source_id;SELECT cheque_id,event_id INTO replacement_parent,replacement_event FROM hamdee_private.security_deposit_refunds WHERE id=NEW.replacement_id;END IF;
  IF replacement_parent IS DISTINCT FROM parent OR replacement_event IS DISTINCT FROM NEW.event_id THEN RAISE EXCEPTION 'same-source replacement evidence required';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER correction_evidence AFTER INSERT ON hamdee_private.financial_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_financial_correction();
REVOKE ALL ON FUNCTION hamdee_private.check_financial_correction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_financial_correction() TO hamdee_runtime;

-- Restore the prior car-source capability additively. Existing old013 data is
-- preserved; a partial/unexpected table must be reconciled before this script.
ALTER TABLE hamdee_private.car_vehicles ALTER COLUMN registration DROP NOT NULL;
ALTER TABLE hamdee_private.car_vehicles ALTER COLUMN make DROP NOT NULL;
ALTER TABLE hamdee_private.car_vehicles DROP CONSTRAINT car_vehicles_status_check;
ALTER TABLE hamdee_private.car_vehicles ADD CONSTRAINT car_vehicles_status_check CHECK(status IN ('active','maintenance','inactive','needs_confirmation'));
DO $$ BEGIN
 IF to_regclass('hamdee_private.car_source_references') IS NULL THEN
  CREATE TABLE hamdee_private.car_source_references(id uuid PRIMARY KEY,vehicle_id uuid NOT NULL REFERENCES hamdee_private.car_vehicles(id) ON DELETE RESTRICT,source_key varchar(240) NOT NULL UNIQUE CHECK(length(trim(source_key))>0),source_reference varchar(1000) NOT NULL CHECK(length(trim(source_reference))>0),amount_reference varchar(100) NOT NULL DEFAULT '',event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE INDEX car_source_vehicle ON hamdee_private.car_source_references(vehicle_id,id);
  CREATE TRIGGER car_source_immutable BEFORE UPDATE OR DELETE ON hamdee_private.car_source_references FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
  ALTER TABLE hamdee_private.car_source_references ENABLE ROW LEVEL SECURITY;ALTER TABLE hamdee_private.car_source_references FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON hamdee_private.car_source_references FROM PUBLIC;
  CREATE POLICY car_source_read ON hamdee_private.car_source_references FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
  CREATE POLICY car_source_insert ON hamdee_private.car_source_references FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner());
  GRANT SELECT,INSERT ON hamdee_private.car_source_references TO hamdee_runtime;
 ELSE
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='hamdee_private.car_source_references'::regclass AND attnum>0 AND NOT attisdropped)<>6
  OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='hamdee_private.car_source_references'::regclass AND relrowsecurity AND relforcerowsecurity)
  OR (SELECT array_agg(attname::text||':'||format_type(atttypid,atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid='hamdee_private.car_source_references'::regclass AND attnum>0 AND NOT attisdropped)
   IS DISTINCT FROM ARRAY['id:uuid','vehicle_id:uuid','source_key:character varying(240)','source_reference:character varying(1000)','amount_reference:character varying(100)','event_id:uuid']::text[]
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hamdee_private.car_source_references'::regclass AND attnum>0 AND NOT attisdropped AND NOT attnotnull)
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='hamdee_private.car_source_references'::regclass AND contype IN ('p','u','f'))<>4
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hamdee_private.car_source_references'::regclass AND NOT tgisinternal AND tgfoid='hamdee_private.append_only()'::regprocedure)
  OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hamdee_private.car_source_references'::regclass AND (a.grantee NOT IN(c.relowner,'hamdee_runtime'::regrole) OR a.grantee='hamdee_runtime'::regrole AND a.privilege_type NOT IN('SELECT','INSERT')))
  THEN RAISE EXCEPTION 'review existing car source schema before upgrade';END IF;
 END IF;
END $$;

-- Backfill after all DDL: PostgreSQL forbids ALTER TABLE while deferrable FK
-- trigger events from a populated backfill are pending.
INSERT INTO hamdee_private.rental_refund_funding_links(collection_id,entry_id,event_id)
 SELECT r.id,m.id,e.id FROM hamdee_private.rent_collections r JOIN hamdee_private.ops_events e ON e.detail->>'collectionId'=r.id::text JOIN hamdee_private.ops_money m ON m.event_id=e.id AND m.entry_kind='expense' WHERE r.kind='deposit_refund' AND m.classification='deposit-refund';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM hamdee_private.rental_refund_funding_links l JOIN hamdee_private.ops_money m ON m.reversal_of=l.entry_id)
 THEN RAISE EXCEPTION 'existing refund reversal requires reviewed source reconciliation';END IF;END $$;
