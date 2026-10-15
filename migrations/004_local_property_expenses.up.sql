-- Additive local-only PostgreSQL operations, not hosted execution authority.
-- Manual costs/payments; no recognition, profit or warranty-waiver rules.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'local HAMDEE schema required'; END IF;
END $$;
CREATE TABLE hamdee_private.expense_events (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES hamdee_private.properties(id),
 entity_id uuid NOT NULL, action text NOT NULL, detail jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hamdee_private.maintenance_jobs (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES hamdee_private.properties(id), room_id uuid,
 work_type varchar(120) NOT NULL CHECK(length(trim(work_type))>0), issue varchar(2000) NOT NULL CHECK(length(trim(issue))>0),
 vendor_name varchar(200) NOT NULL DEFAULT '', vendor_contact varchar(500) NOT NULL DEFAULT '',
 opened_date date NOT NULL, notes varchar(2000) NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 work_completed varchar(2000), completed_date date, actual_cost_minor bigint, currency text,
 warranty_start_date date, warranty_end_date date, cost_expense_id uuid,
 event_id uuid NOT NULL REFERENCES hamdee_private.expense_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id), UNIQUE(id,property_id),
 CHECK((warranty_start_date IS NULL AND warranty_end_date IS NULL) OR (warranty_start_date IS NOT NULL AND warranty_end_date IS NOT NULL AND warranty_start_date<=warranty_end_date)),
 CHECK((status='completed' AND work_completed IS NOT NULL AND length(trim(work_completed))>0 AND completed_date IS NOT NULL AND completed_date>=opened_date
   AND actual_cost_minor IS NOT NULL AND actual_cost_minor>=0 AND actual_cost_minor<=999999999999 AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$' AND cost_expense_id IS NOT NULL)
   OR (status<>'completed' AND work_completed IS NULL AND completed_date IS NULL AND actual_cost_minor IS NULL AND currency IS NULL AND cost_expense_id IS NULL))
);
CREATE TABLE hamdee_private.property_expenses (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES hamdee_private.properties(id), room_id uuid,
 category text NOT NULL CHECK(category IN ('landlord','kahramaa','wifi_utilities','maintenance','cleaning','miscellaneous')),
 expense_date date NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0 AND amount_minor<=999999999999),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), vendor_name varchar(200) NOT NULL CHECK(length(trim(vendor_name))>0),
 vendor_contact varchar(500) NOT NULL DEFAULT '', reference varchar(200) NOT NULL DEFAULT '', notes varchar(2000) NOT NULL DEFAULT '',
 maintenance_job_id uuid UNIQUE, event_id uuid NOT NULL REFERENCES hamdee_private.expense_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id),
 FOREIGN KEY(maintenance_job_id,property_id) REFERENCES hamdee_private.maintenance_jobs(id,property_id), UNIQUE(id,property_id),
 CHECK((maintenance_job_id IS NULL AND amount_minor>0) OR (maintenance_job_id IS NOT NULL AND category='maintenance'))
);
CREATE UNIQUE INDEX property_expense_invoice ON hamdee_private.property_expenses(property_id,lower(trim(vendor_name)),upper(trim(reference))) WHERE length(trim(reference))>0;
ALTER TABLE hamdee_private.maintenance_jobs ADD CONSTRAINT completed_job_cost
 FOREIGN KEY(cost_expense_id,property_id) REFERENCES hamdee_private.property_expenses(id,property_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.expense_payments (
 id uuid PRIMARY KEY, expense_id uuid NOT NULL, property_id uuid NOT NULL,
 method text NOT NULL CHECK(method IN ('cash','bank','cheque')), amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=999999999999),
 payment_date date NOT NULL, reference varchar(200) NOT NULL DEFAULT '', status text NOT NULL CHECK(status IN ('recorded','pending')),
 event_id uuid NOT NULL REFERENCES hamdee_private.expense_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(expense_id,property_id) REFERENCES hamdee_private.property_expenses(id,property_id),
 CHECK((method='cheque' AND status='pending') OR (method<>'cheque' AND status='recorded'))
);
CREATE INDEX expense_payment_expense ON hamdee_private.expense_payments(expense_id);
CREATE UNIQUE INDEX expense_payment_reference ON hamdee_private.expense_payments(expense_id,method,upper(trim(reference))) WHERE length(trim(reference))>0;
CREATE TABLE hamdee_private.expense_commands (
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id), key uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL, PRIMARY KEY(actor_id,key)
);
CREATE FUNCTION hamdee_private.guard_maintenance_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'open' OR NEW.version<>1 THEN RAISE EXCEPTION 'job must start open'; END IF;
 ELSIF NEW.id<>OLD.id OR NEW.property_id<>OLD.property_id OR NEW.room_id IS DISTINCT FROM OLD.room_id
  OR NEW.opened_date<>OLD.opened_date OR NEW.work_type<>OLD.work_type OR NEW.version<>OLD.version+1 OR NEW.event_id=OLD.event_id THEN
  RAISE EXCEPTION 'immutable job identity and sequential history required';
 ELSIF OLD.status='cancelled' THEN RAISE EXCEPTION 'cancelled job is final';
 ELSIF OLD.status='completed' AND (to_jsonb(NEW)-ARRAY['version','event_id','warranty_start_date','warranty_end_date','notes'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','event_id','warranty_start_date','warranty_end_date','notes']) THEN
  RAISE EXCEPTION 'completed job cost/history immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_guard BEFORE INSERT OR UPDATE ON hamdee_private.maintenance_jobs FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_maintenance_change();
CREATE FUNCTION hamdee_private.guard_maintenance_cost() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE job hamdee_private.maintenance_jobs;
BEGIN
 IF NEW.maintenance_job_id IS NOT NULL THEN
  SELECT * INTO job FROM hamdee_private.maintenance_jobs WHERE id=NEW.maintenance_job_id;
  IF job.id IS NULL OR job.status<>'completed' OR job.cost_expense_id<>NEW.id OR job.actual_cost_minor<>NEW.amount_minor
   OR job.currency<>NEW.currency OR job.property_id<>NEW.property_id OR job.room_id IS DISTINCT FROM NEW.room_id
   OR job.completed_date<>NEW.expense_date OR job.vendor_name<>NEW.vendor_name THEN RAISE EXCEPTION 'maintenance cost must match completed job'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_cost_guard BEFORE INSERT ON hamdee_private.property_expenses FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_maintenance_cost();
CREATE FUNCTION hamdee_private.require_completed_cost() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM hamdee_private.property_expenses e
  WHERE e.id=NEW.cost_expense_id AND e.maintenance_job_id=NEW.id AND e.property_id=NEW.property_id
   AND e.room_id IS NOT DISTINCT FROM NEW.room_id AND e.category='maintenance' AND e.amount_minor=NEW.actual_cost_minor
   AND e.currency=NEW.currency AND e.expense_date=NEW.completed_date AND e.vendor_name=NEW.vendor_name) THEN
  RAISE EXCEPTION 'completed job requires exactly its matching maintenance cost'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER completed_cost_match AFTER INSERT OR UPDATE ON hamdee_private.maintenance_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_completed_cost();
CREATE FUNCTION hamdee_private.guard_expense_payment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE cost bigint; paid numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('expense-payment:'||NEW.expense_id::text,0));
 SELECT amount_minor INTO cost FROM hamdee_private.property_expenses WHERE id=NEW.expense_id AND property_id=NEW.property_id;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM hamdee_private.expense_payments WHERE expense_id=NEW.expense_id AND status='recorded';
 IF cost IS NULL OR NEW.amount_minor+paid>cost THEN RAISE EXCEPTION 'payment exceeds unpaid expense'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_payment_guard BEFORE INSERT ON hamdee_private.expense_payments FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_expense_payment();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['expense_events','maintenance_jobs','property_expenses','expense_payments','expense_commands'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
  EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
  EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  IF t='maintenance_jobs' THEN
   EXECUTE format('CREATE POLICY owner_update ON hamdee_private.%I FOR UPDATE TO hamdee_runtime USING(hamdee_private.rental_owner()) WITH CHECK(hamdee_private.rental_owner())',t);
  ELSE
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
  END IF;
 END LOOP;
END $$;
GRANT UPDATE(vendor_name,vendor_contact,issue,notes,status,version,work_completed,completed_date,actual_cost_minor,currency,warranty_start_date,warranty_end_date,cost_expense_id,event_id) ON hamdee_private.maintenance_jobs TO hamdee_runtime;
DROP POLICY owner_insert ON hamdee_private.expense_events;
CREATE POLICY owner_insert ON hamdee_private.expense_events FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
DROP POLICY owner_insert ON hamdee_private.expense_commands;
CREATE POLICY owner_insert ON hamdee_private.expense_commands FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
REVOKE ALL ON FUNCTION hamdee_private.guard_maintenance_change(),hamdee_private.guard_maintenance_cost(),hamdee_private.require_completed_cost(),hamdee_private.guard_expense_payment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_maintenance_change(),hamdee_private.guard_maintenance_cost(),hamdee_private.require_completed_cost(),hamdee_private.guard_expense_payment() TO hamdee_runtime;
