-- Generic, manually numbered DISPOSABLE LOCAL ONLY. Requires 001-004 + 006;
-- independent partner 005 is neither loaded nor modified. No hosted authority.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
  OR to_regclass('hamdee_private.ops_events') IS NULL OR to_regclass('hamdee_private.ops_commands') IS NULL THEN
  RAISE EXCEPTION 'disposable local HAMDEE operations schema required';END IF;
END $$;
CREATE TABLE hamdee_private.car_vehicles(id uuid PRIMARY KEY,
 registration varchar(80) NOT NULL UNIQUE CHECK(registration=upper(trim(registration)) AND length(registration)>0),
 make varchar(120) NOT NULL CHECK(length(trim(make))>0),model varchar(120) NOT NULL CHECK(length(trim(model))>0),
 status text NOT NULL CHECK(status IN ('active','maintenance','inactive')),notes varchar(2000) NOT NULL DEFAULT '',version integer NOT NULL CHECK(version>0),
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE hamdee_private.car_vehicle_revisions(vehicle_id uuid NOT NULL REFERENCES hamdee_private.car_vehicles(id) ON DELETE RESTRICT,
 version integer NOT NULL,profile jsonb NOT NULL,event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(vehicle_id,version));
ALTER TABLE hamdee_private.car_vehicles ADD CONSTRAINT car_current_vehicle_revision FOREIGN KEY(id,version)
 REFERENCES hamdee_private.car_vehicle_revisions(vehicle_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.car_agreements(id uuid PRIMARY KEY,vehicle_id uuid NOT NULL REFERENCES hamdee_private.car_vehicles(id) ON DELETE RESTRICT,
 agreement_key uuid NOT NULL UNIQUE,customer_name varchar(200) NOT NULL CHECK(length(trim(customer_name))>0),customer_contact varchar(500) NOT NULL DEFAULT '',
 start_date date NOT NULL,end_date date NOT NULL CHECK(end_date>=start_date),
 agreed_amount numeric NOT NULL CHECK(agreed_amount>=0 AND agreed_amount<1000000000000000000 AND scale(agreed_amount)<=12),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),billing_period varchar(120) NOT NULL CHECK(length(trim(billing_period))>0),reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 previous_agreement_id uuid,vehicle_snapshot jsonb NOT NULL,event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(id,vehicle_id),UNIQUE(id,vehicle_id,currency),FOREIGN KEY(previous_agreement_id,vehicle_id) REFERENCES hamdee_private.car_agreements(id,vehicle_id) ON DELETE RESTRICT);
CREATE TABLE hamdee_private.car_receipts(id uuid PRIMARY KEY,agreement_id uuid NOT NULL,vehicle_id uuid NOT NULL,receipt_key uuid NOT NULL UNIQUE,
 received_date date NOT NULL,amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 method text NOT NULL CHECK(method IN ('cash','bank','cheque')),status text NOT NULL CHECK((method='cheque' AND status='pending') OR (method<>'cheque' AND status='recorded')),
 reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(agreement_id,vehicle_id,currency) REFERENCES hamdee_private.car_agreements(id,vehicle_id,currency) ON DELETE RESTRICT);
CREATE TABLE hamdee_private.car_expenses(id uuid PRIMARY KEY,vehicle_id uuid NOT NULL REFERENCES hamdee_private.car_vehicles(id) ON DELETE RESTRICT,agreement_id uuid,
 expense_key uuid NOT NULL UNIQUE,expense_date date NOT NULL,amount numeric NOT NULL CHECK(amount>=0 AND amount<1000000000000000000 AND scale(amount)<=12),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 kind text NOT NULL CHECK(kind IN ('expense','maintenance')),description varchar(2000) NOT NULL CHECK(length(trim(description))>0),vendor_name varchar(200) NOT NULL DEFAULT '',reference varchar(200) NOT NULL DEFAULT '',notes varchar(2000) NOT NULL DEFAULT '',
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(agreement_id,vehicle_id) REFERENCES hamdee_private.car_agreements(id,vehicle_id) ON DELETE RESTRICT);
CREATE INDEX car_agreement_vehicle ON hamdee_private.car_agreements(vehicle_id,start_date,id);
CREATE INDEX car_agreement_previous ON hamdee_private.car_agreements(previous_agreement_id);
CREATE INDEX car_receipt_agreement ON hamdee_private.car_receipts(agreement_id,status);
CREATE INDEX car_receipt_picker ON hamdee_private.car_receipts(received_date,id);
CREATE INDEX car_receipt_vehicle ON hamdee_private.car_receipts(vehicle_id,currency,received_date);
CREATE INDEX car_expense_vehicle ON hamdee_private.car_expenses(vehicle_id,currency,expense_date);
CREATE INDEX car_expense_agreement ON hamdee_private.car_expenses(agreement_id);

CREATE FUNCTION hamdee_private.guard_car_vehicle() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.version<>OLD.version+1 OR NEW.event_id=OLD.event_id)) THEN RAISE EXCEPTION 'next immutable vehicle revision required';END IF;RETURN NEW;END $$;
CREATE TRIGGER car_vehicle_change BEFORE INSERT OR UPDATE ON hamdee_private.car_vehicles FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_car_vehicle();
CREATE FUNCTION hamdee_private.check_car_vehicle() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.car_vehicle_revisions r WHERE r.vehicle_id=NEW.id AND r.version=NEW.version AND r.event_id=NEW.event_id AND r.profile=to_jsonb(NEW)-'event_id') THEN RAISE EXCEPTION 'matching vehicle snapshot required';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER car_vehicle_snapshot AFTER INSERT OR UPDATE ON hamdee_private.car_vehicles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_car_vehicle();
CREATE FUNCTION hamdee_private.guard_car_agreement() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v hamdee_private.car_vehicles;p hamdee_private.car_agreements;BEGIN
 SELECT * INTO v FROM hamdee_private.car_vehicles WHERE id=NEW.vehicle_id;
 IF v.id IS NULL OR NEW.vehicle_snapshot IS DISTINCT FROM to_jsonb(v)-'event_id' THEN RAISE EXCEPTION 'matching historical vehicle snapshot required';END IF;
 IF v.status<>'active' THEN RAISE EXCEPTION 'active vehicle required for a new rental';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF EXISTS(SELECT 1 FROM hamdee_private.car_agreements a WHERE a.vehicle_id=NEW.vehicle_id AND a.start_date<=NEW.end_date AND a.end_date>=NEW.start_date) THEN RAISE EXCEPTION 'vehicle rental date range overlaps';END IF;
 IF NEW.previous_agreement_id IS NOT NULL THEN SELECT * INTO p FROM hamdee_private.car_agreements WHERE id=NEW.previous_agreement_id;
  IF p.id IS NULL OR p.vehicle_id<>NEW.vehicle_id OR p.end_date>=NEW.start_date THEN RAISE EXCEPTION 'new same-vehicle renewal term required';END IF;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER car_agreement_history BEFORE INSERT ON hamdee_private.car_agreements FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_car_agreement();
CREATE FUNCTION hamdee_private.guard_car_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a hamdee_private.car_agreements;paid numeric;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));SELECT * INTO a FROM hamdee_private.car_agreements WHERE id=NEW.agreement_id;
 IF a.id IS NULL OR a.vehicle_id<>NEW.vehicle_id OR a.currency<>NEW.currency THEN RAISE EXCEPTION 'matching rental term/currency required';END IF;
 IF NEW.status='recorded' THEN SELECT coalesce(sum(amount),0) INTO paid FROM hamdee_private.car_receipts WHERE agreement_id=NEW.agreement_id AND status='recorded';
  IF paid+NEW.amount>a.agreed_amount THEN RAISE EXCEPTION 'cash collection exceeds explicit agreed term amount';END IF;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER car_receipt_total BEFORE INSERT ON hamdee_private.car_receipts FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_car_receipt();
CREATE FUNCTION hamdee_private.check_car_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e hamdee_private.ops_events;allowed text[];BEGIN
 SELECT * INTO e FROM hamdee_private.ops_events WHERE id=NEW.event_id;
 allowed:=CASE TG_TABLE_NAME WHEN 'car_vehicles' THEN ARRAY['cars:create-vehicle','cars:update-vehicle'] WHEN 'car_agreements' THEN ARRAY['cars:create-agreement']
  WHEN 'car_receipts' THEN ARRAY['cars:record-collection'] ELSE ARRAY['cars:record-expense','cars:record-maintenance'] END;
 IF e.id IS NULL OR NOT(e.action=ANY(allowed)) OR e.detail->'data'->>'id' IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'matching car event evidence required';END IF;
 RETURN NULL;END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['car_vehicles','car_vehicle_revisions','car_agreements','car_receipts','car_expenses'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY car_owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
  EXECUTE format('CREATE POLICY car_owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  IF t='car_vehicles' THEN
   EXECUTE format('CREATE POLICY car_owner_update ON hamdee_private.%I FOR UPDATE TO hamdee_runtime USING(hamdee_private.rental_owner()) WITH CHECK(hamdee_private.rental_owner())',t);
   EXECUTE format('CREATE TRIGGER immutable_delete BEFORE DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
  ELSE EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);END IF;
  IF t<>'car_vehicle_revisions' THEN EXECUTE format('CREATE CONSTRAINT TRIGGER car_audit AFTER INSERT OR UPDATE ON hamdee_private.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_car_audit()',t);END IF;
 END LOOP;END $$;
GRANT UPDATE(registration,make,model,status,notes,version,event_id) ON hamdee_private.car_vehicles TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.guard_car_vehicle(),hamdee_private.check_car_vehicle(),hamdee_private.guard_car_agreement(),hamdee_private.guard_car_receipt(),hamdee_private.check_car_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_car_vehicle(),hamdee_private.check_car_vehicle(),hamdee_private.guard_car_agreement(),hamdee_private.guard_car_receipt(),hamdee_private.check_car_audit() TO hamdee_runtime;
