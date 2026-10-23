-- PROPOSED ONLY: requires separate owner approval before hosted execution.
-- Dedicated HAMDEE development project jfynuafwsympxxpkqags, Singapore.
-- Existing real metadata and all41 base tables are preserved; no seed or ledger posting.
-- Operator must independently verify project identity, current001-004+006+007
-- migration evidence and a restricted recovery export before executing this whole transaction.
-- Legacy application marker literals remain unchanged. No account, credential or role changes.
-- Unexpected state/permissions or any error requires explicit ROLLBACK; do not weaken assertions.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock(hashtextextended('hamdee-partner-development-008',0));
DO $hosted_partners$
DECLARE
 reviewed_source CONSTANT text := $reviewed_008$-- Migration 008: disposable LOCAL HAMDEE only. Hosted execution requires the separate reviewed wrapper.
-- Recorded movements only: no entitlement, profit, eligibility or allocation rules.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'local HAMDEE schema required';
 END IF;
END $$;

CREATE TABLE hamdee_private.partner_events (
 id uuid PRIMARY KEY, partner_id uuid NOT NULL, property_id uuid REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
 entity_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('create-partner','update-partner','link-property','record-entry')),
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'), actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,partner_id), UNIQUE(id,partner_id,property_id,entity_id),
 CHECK((action IN ('create-partner','update-partner') AND property_id IS NULL AND entity_id=partner_id)
    OR (action IN ('link-property','record-entry') AND property_id IS NOT NULL))
);
CREATE TABLE hamdee_private.partners (
 id uuid PRIMARY KEY, name varchar(200) NOT NULL CHECK(length(trim(name))>0),
 phone varchar(60) NOT NULL DEFAULT '', email varchar(254) NOT NULL DEFAULT '', notes varchar(2000) NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
 event_id uuid NOT NULL, FOREIGN KEY(event_id,id) REFERENCES hamdee_private.partner_events(id,partner_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hamdee_private.partner_events ADD CONSTRAINT partner_event_contact
 FOREIGN KEY(partner_id) REFERENCES hamdee_private.partners(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.partner_revisions (
 partner_id uuid NOT NULL REFERENCES hamdee_private.partners(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version>0),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'), event_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(partner_id,version),
 FOREIGN KEY(event_id,partner_id) REFERENCES hamdee_private.partner_events(id,partner_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hamdee_private.partners ADD CONSTRAINT partner_current_revision
 FOREIGN KEY(id,version) REFERENCES hamdee_private.partner_revisions(partner_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hamdee_private.property_partners (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
 partner_id uuid NOT NULL REFERENCES hamdee_private.partners(id) ON DELETE RESTRICT,
 notes varchar(2000) NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp(), event_id uuid NOT NULL,
 UNIQUE(property_id,partner_id),
 FOREIGN KEY(event_id,partner_id,property_id,id) REFERENCES hamdee_private.partner_events(id,partner_id,property_id,entity_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hamdee_private.partner_entries (
 id uuid PRIMARY KEY, property_id uuid NOT NULL, partner_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('contribution','withdrawal')), entry_date date NOT NULL CHECK(entry_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
 -- Unconstrained numeric avoids silent scale rounding. These are technical
 -- storage bounds, not a currency minor-unit convention; no value is rounded.
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000000000 AND scale(amount)<=12),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), reference varchar(200) NOT NULL DEFAULT '', notes varchar(2000) NOT NULL DEFAULT '',
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), event_id uuid NOT NULL,
 FOREIGN KEY(property_id,partner_id) REFERENCES hamdee_private.property_partners(property_id,partner_id) ON DELETE RESTRICT,
 FOREIGN KEY(event_id,partner_id,property_id,id) REFERENCES hamdee_private.partner_events(id,partner_id,property_id,entity_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hamdee_private.partner_commands (
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT, key uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL, PRIMARY KEY(actor_id,key)
);
CREATE INDEX property_partners_partner ON hamdee_private.property_partners(partner_id,property_id);
CREATE INDEX partner_entries_statement ON hamdee_private.partner_entries(partner_id,property_id,currency,entry_date,id);
CREATE INDEX partner_entries_property_date ON hamdee_private.partner_entries(property_id,entry_date,id);
CREATE INDEX partner_events_history ON hamdee_private.partner_events(partner_id,occurred_at,id);
CREATE INDEX partner_events_property ON hamdee_private.partner_events(property_id);

CREATE FUNCTION hamdee_private.partner_record_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM hamdee_private.app_users u JOIN hamdee_private.role_assignments g ON g.user_id=u.id
 WHERE u.id=hamdee_private.actor() AND u.enabled AND g.role='admin' AND g.portfolio AND g.revoked_at IS NULL)
$$;
CREATE FUNCTION hamdee_private.guard_partner_profile() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.created_by IS DISTINCT FROM hamdee_private.actor() THEN RAISE EXCEPTION 'invalid partner creation'; END IF;
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
   OR NEW.version<>OLD.version+1 OR NEW.event_id=OLD.event_id THEN RAISE EXCEPTION 'immutable partner identity and next revision required';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER partner_profile_guard BEFORE INSERT OR UPDATE ON hamdee_private.partners
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_partner_profile();
CREATE TRIGGER partner_no_delete BEFORE DELETE ON hamdee_private.partners
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();

-- Evidence must describe the exact immutable record/revision it references.
CREATE FUNCTION hamdee_private.require_partner_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e hamdee_private.partner_events; expected_action text;
BEGIN
 SELECT * INTO e FROM hamdee_private.partner_events WHERE id=NEW.event_id;
 IF TG_TABLE_NAME='partners' THEN
  IF NOT EXISTS(SELECT 1 FROM hamdee_private.partner_revisions r WHERE r.partner_id=NEW.id AND r.version=NEW.version
    AND r.event_id=NEW.event_id AND r.profile=(to_jsonb(NEW)-'event_id')) THEN RAISE EXCEPTION 'matching current partner snapshot required'; END IF;
 ELSIF TG_TABLE_NAME='partner_revisions' THEN
  expected_action:=CASE WHEN NEW.version=1 THEN 'create-partner' ELSE 'update-partner' END;
  IF e.id IS NULL OR e.partner_id<>NEW.partner_id OR e.action<>expected_action OR e.detail->'record' IS DISTINCT FROM NEW.profile
    THEN RAISE EXCEPTION 'matching partner revision audit required'; END IF;
 ELSIF TG_TABLE_NAME='property_partners' THEN
  IF e.id IS NULL OR e.action<>'link-property' OR e.detail->'record' IS DISTINCT FROM (to_jsonb(NEW)-'event_id')
    THEN RAISE EXCEPTION 'matching property partner audit required'; END IF;
 ELSE
  IF e.id IS NULL OR e.action<>'record-entry' OR e.detail->'record' IS DISTINCT FROM (to_jsonb(NEW)-'event_id'-'amount'||jsonb_build_object('amount',NEW.amount::text))
    THEN RAISE EXCEPTION 'matching entry audit required'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER partner_profile_evidence AFTER INSERT OR UPDATE ON hamdee_private.partners DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_partner_evidence();
CREATE CONSTRAINT TRIGGER partner_revision_evidence AFTER INSERT ON hamdee_private.partner_revisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_partner_evidence();
CREATE CONSTRAINT TRIGGER partner_link_evidence AFTER INSERT ON hamdee_private.property_partners DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_partner_evidence();
CREATE CONSTRAINT TRIGGER partner_entry_evidence AFTER INSERT ON hamdee_private.partner_entries DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_partner_evidence();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['partners','partner_revisions','property_partners','partner_entries','partner_events','partner_commands'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY partner_owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.partner_record_owner())',t);
  EXECUTE format('CREATE POLICY partner_owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.partner_record_owner())',t);
  EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  IF t='partners' THEN
   EXECUTE format('CREATE POLICY partner_owner_update ON hamdee_private.%I FOR UPDATE TO hamdee_runtime USING(hamdee_private.partner_record_owner()) WITH CHECK(hamdee_private.partner_record_owner())',t);
  ELSE
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
  END IF;
 END LOOP;
END $$;
DROP POLICY partner_owner_insert ON hamdee_private.partner_events;
CREATE POLICY partner_owner_insert ON hamdee_private.partner_events FOR INSERT TO hamdee_runtime
 WITH CHECK(hamdee_private.partner_record_owner() AND actor_id=hamdee_private.actor());
DROP POLICY partner_owner_insert ON hamdee_private.partner_commands;
CREATE POLICY partner_owner_insert ON hamdee_private.partner_commands FOR INSERT TO hamdee_runtime
 WITH CHECK(hamdee_private.partner_record_owner() AND actor_id=hamdee_private.actor());
GRANT UPDATE(name,phone,email,notes,version,event_id) ON hamdee_private.partners TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.partner_record_owner(),hamdee_private.guard_partner_profile(),hamdee_private.require_partner_evidence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.partner_record_owner(),hamdee_private.guard_partner_profile(),hamdee_private.require_partner_evidence() TO hamdee_runtime;
$reviewed_008$;
 source_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''local-test''';
 hosted_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''synthetic-development'' AND project_ref=''jfynuafwsympxxpkqags'' AND data_class=''synthetic_only''';
 base_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties','properties','property_access','property_revisions','audit_events','commands','rental_events','rooms','tenants','rental_agreements','rent_dues','rent_collections','rent_allocations','rental_commands','expense_events','maintenance_jobs','property_expenses','expense_payments','expense_commands','ops_events','ops_collectors','ops_collector_revisions','ops_accounts','ops_receipts','ops_claims','ops_collections','ops_collection_reversals','ops_transfers','ops_money','ops_expense_keys','ops_commands','car_vehicles','car_vehicle_revisions','car_agreements','car_receipts','car_expenses'];
 operations_tables CONSTANT text[] := ARRAY['partners','partner_revisions','property_partners','partner_entries','partner_events','partner_commands'];
 operations_functions CONSTANT text[] := ARRAY['partner_record_owner','guard_partner_profile','require_partner_evidence'];
 read_only_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties'];
 runtime oid; backend oid; schema_id oid; operator_id oid; phase integer; t text; r record;
 before_fingerprints jsonb := '{}'::jsonb; fingerprint text; before_rows jsonb := '{}'::jsonb; row_count bigint; before_catalog jsonb;
BEGIN
 IF encode(sha256(convert_to(replace(reviewed_source,E'\r\n',E'\n'),'UTF8')),'hex')<>'c43c24dec0564ae14efab5a88ff68bf832533666e6fddd5ecea214554e24fa41'
 OR (length(reviewed_source)-length(replace(reviewed_source,source_guard,'')))/length(source_guard)<>1 THEN
  RAISE EXCEPTION 'reviewed local008 digest/guard mismatch'; END IF;
 IF current_database()<>'postgres' OR current_setting('server_version_num')::integer<170000 THEN
  RAISE EXCEPTION 'reviewed PostgreSQL database/version required'; END IF;
 SELECT oid,nspowner INTO schema_id,operator_id FROM pg_namespace WHERE nspname='hamdee_private';
 IF schema_id IS NULL OR operator_id<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
 OR current_user IN ('hamdee_backend','hamdee_runtime') THEN
  RAISE EXCEPTION 'approved existing private-schema owner must execute migration'; END IF;
 -- Forced-RLS table ownership alone does not provide complete row visibility.
 -- Preservation counts/fingerprints must never be computed over filtered rows.
 -- Assert existing authority only; do not grant or alter any role to proceed.
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'unfiltered preservation verification requires approved RLS-bypassing schema owner; stop for review'; END IF;
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
  IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables) AND relkind='r')<>41
  OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(ARRAY['ops_claim_placement_date','guard_ops_collector','check_ops_collector','check_ops_account','guard_ops_collection','guard_ops_money','check_ops_money','check_ops_collection_reversal']))<>8
  OR to_regprocedure('hamdee_private.actor()') IS NULL OR to_regprocedure('hamdee_private.can_access(uuid,text)') IS NULL
  OR to_regprocedure('hamdee_private.append_only()') IS NULL OR to_regprocedure('hamdee_private.rental_owner()') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.properties'::regclass AND conname='property_current_revision' AND condeferrable AND condeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.property_revisions'::regclass AND conname='revision_requires_audit' AND condeferrable AND condeferred) THEN
   RAISE EXCEPTION 'reviewed hosted001-004+006+007 objects required'; END IF;
  IF (SELECT count(*) FROM hamdee_private.application_identity)<>1 OR NOT EXISTS(
   SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='synthetic-development'
   AND project_ref='jfynuafwsympxxpkqags' AND data_class='synthetic_only') THEN
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
     (r.relname='car_vehicles' AND c.attname=ANY(ARRAY['registration','make','model','status','notes','version','event_id'])) OR
     (r.relname='partners' AND c.attname=ANY(ARRAY['name','phone','email','notes','version','event_id'])))) THEN
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
   IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relkind='r')<>41
   OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=schema_id AND (relname='partners' OR relname='property_partners' OR left(relname,8)='partner_'))
   OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace=schema_id AND (typname IN('partners','_partners','property_partners','_property_partners') OR left(typname,8)='partner_' OR left(typname,9)='_partner_'))
   OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace=schema_id AND (proname=ANY(operations_functions) OR left(proname,8)='partner_' OR left(proname,14)='guard_partner_' OR left(proname,16)='require_partner_')) THEN
    RAISE EXCEPTION 'unexpected migration state or existing/partial partner objects refused'; END IF;
   SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    INTO before_catalog FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables);
   FOREACH t IN ARRAY base_tables LOOP
    EXECUTE format('LOCK TABLE hamdee_private.%I IN SHARE MODE',t);
    EXECUTE format('SELECT count(*) FROM hamdee_private.%I',t) INTO row_count;
    before_rows := before_rows||jsonb_build_object(t,row_count);
    EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,E''\n'' ORDER BY to_jsonb(r)::text),''''),''UTF8'')),''hex'') FROM hamdee_private.%I r',t) INTO fingerprint;
    before_fingerprints:=before_fingerprints||jsonb_build_object(t,fingerprint);
   END LOOP;
   -- Only the environment preflight predicate changes. All reviewed DDL/logic is embedded verbatim.
   EXECUTE replace(reviewed_source,source_guard,hosted_guard);
  ELSE
   IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(operations_tables) AND relkind='r' AND relrowsecurity AND relforcerowsecurity)<>6
   OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(operations_functions))<>3 THEN
    RAISE EXCEPTION 'partner installation incomplete'; END IF;
   IF before_catalog IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables)) THEN
    RAISE EXCEPTION 'base table identity/permissions changed'; END IF;
   FOREACH t IN ARRAY base_tables||operations_tables LOOP
    EXECUTE format('SELECT count(*) FROM hamdee_private.%I',t) INTO row_count;
    IF (t=ANY(base_tables) AND row_count<>(before_rows->>t)::bigint) OR (t=ANY(operations_tables) AND row_count<>0) THEN
     RAISE EXCEPTION 'unexpected existing data change or partner seed'; END IF;
    IF t=ANY(base_tables) THEN
     EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,E''\n'' ORDER BY to_jsonb(r)::text),''''),''UTF8'')),''hex'') FROM hamdee_private.%I r',t) INTO fingerprint;
     IF fingerprint IS DISTINCT FROM before_fingerprints->>t THEN RAISE EXCEPTION 'existing record changed'; END IF;
    END IF;
   END LOOP;
  END IF;
 END LOOP;
END $hosted_partners$;
COMMIT;
