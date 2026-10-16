-- PROPOSED ONLY: separate approval required for dedicated synthetic-development car007.
-- Operator must independently select project dytlzfwbgeuhzgzemqsf. SQL marker alone
-- cannot attest remote project identity. Requires reviewed hosted001-004 +006,
-- unchanged restricted hamdee_backend LOGIN and approved private-schema owner.
-- No role/account/credential creation, seed, down/reset or partial rerun.
-- Execute WHOLE transaction with stop-on-error; ROLLBACK explicitly after failure.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock(hashtextextended('hamdee-car-synthetic-development-007',0));
DO $hosted_car$
DECLARE
 reviewed_source CONSTANT text := $reviewed_007$-- Generic, manually numbered DISPOSABLE LOCAL ONLY. Requires 001-004 + 006;
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
$reviewed_007$;
 source_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''local-test''';
 hosted_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''synthetic-development'' AND project_ref=''dytlzfwbgeuhzgzemqsf'' AND data_class=''synthetic_only''';
 base_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties','properties','property_access','property_revisions','audit_events','commands','rental_events','rooms','tenants','rental_agreements','rent_dues','rent_collections','rent_allocations','rental_commands','expense_events','maintenance_jobs','property_expenses','expense_payments','expense_commands','ops_events','ops_collectors','ops_collector_revisions','ops_accounts','ops_receipts','ops_claims','ops_collections','ops_collection_reversals','ops_transfers','ops_money','ops_expense_keys','ops_commands'];
 operations_tables CONSTANT text[] := ARRAY['car_vehicles','car_vehicle_revisions','car_agreements','car_receipts','car_expenses'];
 operations_functions CONSTANT text[] := ARRAY['guard_car_vehicle','check_car_vehicle','guard_car_agreement','guard_car_receipt','check_car_audit'];
 read_only_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties'];
 runtime oid; backend oid; schema_id oid; operator_id oid; phase integer; t text; r record;
 before_rows jsonb := '{}'::jsonb; row_count bigint; before_catalog jsonb;
BEGIN
 IF encode(sha256(convert_to(replace(reviewed_source,E'\r\n',E'\n'),'UTF8')),'hex')<>'9baa4297ceffab72b45265ad7baadd799e3512e7d67049054914d2a63df07f59'
 OR (length(reviewed_source)-length(replace(reviewed_source,source_guard,'')))/length(source_guard)<>1 THEN
  RAISE EXCEPTION 'reviewed local007 digest/guard mismatch'; END IF;
 IF current_database()<>'postgres' OR current_setting('server_version_num')::integer<170000 THEN
  RAISE EXCEPTION 'reviewed PostgreSQL database/version required'; END IF;
 SELECT oid,nspowner INTO schema_id,operator_id FROM pg_namespace WHERE nspname='hamdee_private';
 IF schema_id IS NULL OR operator_id<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
 OR current_user IN ('hamdee_backend','hamdee_runtime') THEN
  RAISE EXCEPTION 'approved existing private-schema owner must execute migration'; END IF;
 SELECT oid INTO runtime FROM pg_roles WHERE rolname='hamdee_runtime';
 SELECT oid INTO backend FROM pg_roles WHERE rolname='hamdee_backend';
 IF runtime IS NULL OR backend IS NULL THEN RAISE EXCEPTION 'reviewed application roles required'; END IF;

 FOR phase IN 0..1 LOOP
  -- Validate before and after; never repair unexpected permissions in place.
  IF EXISTS(SELECT 1 FROM pg_roles WHERE oid IN(runtime,backend) AND
   (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit OR
    (oid=runtime AND rolcanlogin) OR (oid=backend AND NOT rolcanlogin)))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime)
  OR (SELECT count(*) FROM pg_auth_members WHERE member=backend)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=backend AND roleid=runtime AND NOT admin_option AND NOT inherit_option AND set_option)
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid IN(runtime,backend) AND member NOT IN(backend,operator_id)) THEN
   RAISE EXCEPTION 'unsafe application role attributes/membership'; END IF;
  IF NOT has_database_privilege(backend,current_database(),'CONNECT')
  OR has_database_privilege(backend,current_database(),'CREATE')
  OR NOT has_schema_privilege(runtime,schema_id,'USAGE') OR has_schema_privilege(runtime,schema_id,'CREATE')
  OR has_schema_privilege(backend,schema_id,'USAGE') OR has_schema_privilege(backend,schema_id,'CREATE')
  OR EXISTS(SELECT 1 FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE oid=schema_id)) a
   WHERE a.grantee NOT IN(operator_id,runtime) OR (a.grantee=runtime AND (a.privilege_type<>'USAGE' OR a.is_grantable))) THEN
   RAISE EXCEPTION 'unsafe schema/database privileges'; END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN('anon','authenticated','service_role'))<>3
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') AND has_schema_privilege(oid,schema_id,'USAGE')) THEN
   RAISE EXCEPTION 'provider roles must remain excluded from private schema'; END IF;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables) AND relkind='r')<>36
  OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(ARRAY['ops_claim_placement_date','guard_ops_collector','check_ops_collector','check_ops_account','guard_ops_collection','guard_ops_money','check_ops_money','check_ops_collection_reversal']))<>8
  OR to_regprocedure('hamdee_private.actor()') IS NULL OR to_regprocedure('hamdee_private.can_access(uuid,text)') IS NULL
  OR to_regprocedure('hamdee_private.append_only()') IS NULL OR to_regprocedure('hamdee_private.rental_owner()') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.properties'::regclass AND conname='property_current_revision' AND condeferrable AND condeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.property_revisions'::regclass AND conname='revision_requires_audit' AND condeferrable AND condeferred) THEN
   RAISE EXCEPTION 'reviewed hosted001-004+006 objects required'; END IF;
  IF (SELECT count(*) FROM hamdee_private.application_identity)<>1 OR NOT EXISTS(
   SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='synthetic-development'
   AND project_ref='dytlzfwbgeuhzgzemqsf' AND data_class='synthetic_only') THEN
   RAISE EXCEPTION 'dedicated synthetic-development marker required'; END IF;
  FOR r IN SELECT c.* FROM pg_class c WHERE c.relnamespace=schema_id AND c.relname=ANY(base_tables||operations_tables) AND c.relkind='r' LOOP
   IF r.relowner<>operator_id OR NOT has_table_privilege(runtime,r.oid,'SELECT')
   OR has_table_privilege(runtime,r.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR has_any_column_privilege(runtime,r.oid,'REFERENCES')
   OR has_table_privilege(runtime,r.oid,'UPDATE')
   OR (r.relname=ANY(read_only_tables) AND has_any_column_privilege(runtime,r.oid,'INSERT,UPDATE'))
   OR (NOT r.relname=ANY(read_only_tables) AND NOT r.relrowsecurity)
   OR (r.relname NOT IN('application_identity','app_users','roles','role_permissions','role_assignments','counterparties','property_access','property_revisions','audit_events','commands') AND NOT r.relforcerowsecurity)
   OR EXISTS(SELECT 1 FROM aclexplode(r.relacl) a WHERE a.grantee NOT IN(operator_id,runtime) OR (a.grantee=runtime AND a.is_grantable))
   OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid=r.oid AND
    (a.grantee NOT IN(operator_id,runtime) OR (a.grantee=runtime AND (a.is_grantable OR a.privilege_type NOT IN('INSERT','UPDATE'))))) THEN
    RAISE EXCEPTION 'unsafe required-table privileges/RLS: %',r.relname; END IF;
   IF EXISTS(SELECT 1 FROM pg_attribute c WHERE c.attrelid=r.oid AND c.attnum>0 AND NOT c.attisdropped
    AND has_column_privilege(runtime,r.oid,c.attnum,'UPDATE') AND NOT (
     (r.relname='properties' AND c.attname=ANY(ARRAY['name','location','counterparty_id','lifecycle_status','updated_at','updated_by','version','archived_at','archived_by','archive_reason'])) OR
     (r.relname='rooms' AND c.attname=ANY(ARRAY['code','label','version','event_id'])) OR
     (r.relname='tenants' AND c.attname=ANY(ARRAY['name','phone','email','notes','version','event_id'])) OR
     (r.relname='rental_agreements' AND c.attname=ANY(ARRAY['end_date','version','event_id'])) OR
     (r.relname='maintenance_jobs' AND c.attname=ANY(ARRAY['vendor_name','vendor_contact','issue','notes','status','version','work_completed','completed_date','actual_cost_minor','currency','warranty_start_date','warranty_end_date','cost_expense_id','event_id'])) OR
     (r.relname='ops_collectors' AND c.attname=ANY(ARRAY['name','phone','notes','version','event_id'])) OR
     (r.relname='car_vehicles' AND c.attname=ANY(ARRAY['registration','make','model','status','notes','version','event_id'])))) THEN
    RAISE EXCEPTION 'unexpected runtime update column: %',r.relname; END IF;
   IF r.relname='properties' AND (has_table_privilege(runtime,r.oid,'INSERT') OR EXISTS(
    SELECT 1 FROM pg_attribute c WHERE c.attrelid=r.oid AND c.attnum>0 AND NOT c.attisdropped
    AND has_column_privilege(runtime,r.oid,c.attnum,'INSERT') AND NOT c.attname=ANY(ARRAY['id','name','location','counterparty_id','created_by','updated_by']))) THEN
    RAISE EXCEPTION 'unexpected runtime property insert privileges'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=schema_id AND (p.prosecdef OR p.proowner<>operator_id
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR NOT has_function_privilege(runtime,p.oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee NOT IN(operator_id,runtime) OR (a.grantee=runtime AND a.is_grantable)))) THEN
   RAISE EXCEPTION 'unsafe private function owner/security/privileges'; END IF;

  IF phase=0 THEN
   IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=schema_id AND left(relname,4)='car_')
   OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace=schema_id AND (left(typname,4)='car_' OR left(typname,5)='_car_'))
   OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace=schema_id AND (left(proname,4)='car_' OR left(proname,10)='guard_car_' OR left(proname,10)='check_car_')) THEN
    RAISE EXCEPTION 'existing/partial car objects refused'; END IF;
   SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    INTO before_catalog FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables);
   FOREACH t IN ARRAY base_tables LOOP
    EXECUTE format('LOCK TABLE hamdee_private.%I IN SHARE MODE',t);
    EXECUTE format('SELECT count(*) FROM hamdee_private.%I',t) INTO row_count;
    before_rows := before_rows||jsonb_build_object(t,row_count);
   END LOOP;
   -- Only the environment preflight predicate changes. All reviewed DDL/logic is embedded verbatim.
   EXECUTE replace(reviewed_source,source_guard,hosted_guard);
  ELSE
   IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(operations_tables) AND relkind='r' AND relrowsecurity AND relforcerowsecurity)<>5
   OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(operations_functions))<>5 THEN
    RAISE EXCEPTION 'car installation incomplete'; END IF;
   IF before_catalog IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables)) THEN
    RAISE EXCEPTION 'base table identity/permissions changed'; END IF;
   FOREACH t IN ARRAY base_tables||operations_tables LOOP
    EXECUTE format('SELECT count(*) FROM hamdee_private.%I',t) INTO row_count;
    IF (t=ANY(base_tables) AND row_count<>(before_rows->>t)::bigint) OR (t=ANY(operations_tables) AND row_count<>0) THEN
     RAISE EXCEPTION 'unexpected existing data change or car seed'; END IF;
   END LOOP;
  END IF;
 END LOOP;
END $hosted_car$;
COMMIT;
