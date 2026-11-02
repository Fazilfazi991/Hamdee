-- Additive disposable-local migration; no hosted or production execution authorization.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.ops_money') IS NULL OR to_regclass('hamdee_private.car_agreements') IS NULL THEN
 RAISE EXCEPTION 'local HAMDEE customer dependencies required'; END IF;
END $$;
CREATE TABLE hamdee_private.customer_events(
 id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),action text NOT NULL,
 reason varchar(2000) NOT NULL DEFAULT '',actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE hamdee_private.customer_commands(actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id),key uuid NOT NULL,
 digest text NOT NULL,result jsonb NOT NULL,event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id),PRIMARY KEY(actor_id,key));
CREATE TABLE hamdee_private.customer_kyc(
 customer_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),version integer NOT NULL CHECK(version>0),
 identity_name varchar(200) NOT NULL DEFAULT '',document_type text NOT NULL CHECK(document_type IN ('QID','Passport','Other')),
 document_number varchar(120) NOT NULL DEFAULT '',expiry_date date,nationality varchar(120) NOT NULL DEFAULT '',address varchar(1000) NOT NULL DEFAULT '',
 review_notes varchar(2000) NOT NULL DEFAULT '',status text NOT NULL CHECK(status IN ('pending-review','verified')),
 reviewed_by uuid REFERENCES hamdee_private.app_users(id),reviewed_at timestamptz,event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id),
 PRIMARY KEY(customer_id,version),CHECK((status='verified')=(reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)));
CREATE TABLE hamdee_private.customer_documents(
 id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),purpose text NOT NULL DEFAULT 'kyc' CHECK(purpose IN ('kyc','cheque')),side text NOT NULL CHECK(side IN ('front','back','other')),
 name varchar(200) NOT NULL,mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 1048576),content_sha256 text NOT NULL,
 event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE hamdee_private.customer_car_links(
 agreement_id uuid PRIMARY KEY REFERENCES hamdee_private.car_agreements(id),customer_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),
 event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id));
CREATE TABLE hamdee_private.security_cheques(
 id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),agreement_id uuid REFERENCES hamdee_private.rental_agreements(id),
 car_agreement_id uuid REFERENCES hamdee_private.car_agreements(id),cheque_number varchar(120) NOT NULL,bank varchar(200) NOT NULL,
 drawer_name varchar(200) NOT NULL,cheque_date date NOT NULL,received_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=999999999999),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 notes varchar(2000) NOT NULL DEFAULT '',image_document_id uuid REFERENCES hamdee_private.customer_documents(id),replaces_id uuid UNIQUE REFERENCES hamdee_private.security_cheques(id),
 event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id),CHECK(num_nonnulls(agreement_id,car_agreement_id)<=1));
CREATE TABLE hamdee_private.security_cheque_events(
 cheque_id uuid NOT NULL REFERENCES hamdee_private.security_cheques(id),version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('held','presented','cleared','bounced','returned','cancelled','replaced')),
 business_date date NOT NULL,reason varchar(2000) NOT NULL DEFAULT '',account_id uuid REFERENCES hamdee_private.ops_accounts(id),
 money_entry_id uuid UNIQUE REFERENCES hamdee_private.ops_money(id),funded_receipt_id uuid UNIQUE REFERENCES hamdee_private.ops_receipts(id),rental_collection_id uuid UNIQUE REFERENCES hamdee_private.rent_collections(id),reversal_entry_id uuid UNIQUE REFERENCES hamdee_private.ops_money(id),
 event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id),PRIMARY KEY(cheque_id,version),
 CHECK((status='cleared')=(account_id IS NOT NULL AND money_entry_id IS NOT NULL AND num_nonnulls(funded_receipt_id,rental_collection_id)=1)));
CREATE TABLE hamdee_private.security_deposit_refunds(
 id uuid PRIMARY KEY,cheque_id uuid NOT NULL REFERENCES hamdee_private.security_cheques(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),business_date date NOT NULL,reason varchar(2000) NOT NULL,
 money_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id),event_id uuid NOT NULL REFERENCES hamdee_private.customer_events(id));
CREATE INDEX security_refunds_cheque ON hamdee_private.security_deposit_refunds(cheque_id,business_date);
CREATE INDEX customer_events_customer ON hamdee_private.customer_events(customer_id,occurred_at);
CREATE INDEX customer_documents_customer ON hamdee_private.customer_documents(customer_id);
CREATE INDEX customer_car_customer ON hamdee_private.customer_car_links(customer_id);
CREATE INDEX security_cheques_customer ON hamdee_private.security_cheques(customer_id,received_date);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_events','customer_commands','customer_kyc','customer_documents','customer_car_links','security_cheques','security_cheque_events','security_deposit_refunds'] LOOP
 EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
 EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
 EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
 EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
 END LOOP;
END $$;



DROP POLICY owner_insert ON hamdee_private.customer_events;
CREATE POLICY owner_insert ON hamdee_private.customer_events FOR INSERT TO hamdee_runtime
 WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
DROP POLICY owner_insert ON hamdee_private.customer_commands;
CREATE POLICY owner_insert ON hamdee_private.customer_commands FOR INSERT TO hamdee_runtime
 WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
-- A generic money reversal must not leave a funded cheque/deposit profile stale.
CREATE FUNCTION hamdee_private.check_security_deposit_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE original_cheque uuid;
BEGIN
 IF NEW.reversal_of IS NULL THEN RETURN NULL; END IF;
 SELECT cheque_id INTO original_cheque FROM hamdee_private.security_cheque_events WHERE money_entry_id=NEW.reversal_of;
 IF original_cheque IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hamdee_private.security_cheque_events
 WHERE cheque_id=original_cheque AND reversal_entry_id=NEW.id AND status='bounced' AND business_date=NEW.business_date) THEN
 RAISE EXCEPTION 'explicit linked security cheque correction required'; END IF;
 IF EXISTS(SELECT 1 FROM hamdee_private.security_deposit_refunds WHERE money_entry_id=NEW.reversal_of) THEN
 RAISE EXCEPTION 'deposit refund requires separately reviewed linked correction'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION hamdee_private.check_security_deposit_correction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_security_deposit_correction() TO hamdee_runtime;
CREATE CONSTRAINT TRIGGER security_deposit_money_correction AFTER INSERT ON hamdee_private.ops_money
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_security_deposit_correction();
CREATE FUNCTION hamdee_private.guard_reversed_security_source() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.entry_kind IN ('receipt','collection') AND EXISTS(
 SELECT 1 FROM hamdee_private.ops_money original JOIN hamdee_private.security_cheque_events cleared ON cleared.money_entry_id=original.id
 JOIN hamdee_private.security_cheque_events correction ON correction.cheque_id=cleared.cheque_id AND correction.reversal_entry_id IS NOT NULL
 WHERE original.claim_id=NEW.claim_id) THEN RAISE EXCEPTION 'reversed security clearance cannot be received again'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hamdee_private.guard_reversed_security_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_reversed_security_source() TO hamdee_runtime;
CREATE TRIGGER security_deposit_source_guard BEFORE INSERT ON hamdee_private.ops_money
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_reversed_security_source();
