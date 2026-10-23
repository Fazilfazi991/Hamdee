-- PROPOSED ONLY: separate approval required before hosted009 execution.
-- Dedicated existing HAMDEE project jfynuafwsympxxpkqags, Singapore.
-- Requires verified001-004+006+007+008 catalog, private recovery export and reviewed target identity.
-- Preserves all47 existing tables/rows/permissions; adds one private append-only correction table.
-- Intentional existing catalog evolution is ONLY partner_events_action_check and
-- partner_events_check, adding correct-entry with the same property/identity boundary.
-- No role, credential, original movement, account balance or financial formula changes.
-- Whole transaction only. Any mismatch/error requires ROLLBACK and review, never broader privileges.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock(hashtextextended('hamdee-partner-corrections-009',0));
DO $hosted_partner_corrections$
DECLARE
 reviewed_source CONSTANT text := $reviewed_009$-- Disposable LOCAL only. Reviewed hosted execution requires a separate wrapper.
-- Retained void/replacement records; no profit, settlement or opposite movement.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.partner_entries') IS NULL THEN RAISE EXCEPTION 'local HAMDEE partner008 schema required';END IF;
END $$;
ALTER TABLE hamdee_private.partner_events DROP CONSTRAINT partner_events_action_check;
ALTER TABLE hamdee_private.partner_events ADD CONSTRAINT partner_events_action_check
 CHECK(action IN('create-partner','update-partner','link-property','record-entry','correct-entry'));
ALTER TABLE hamdee_private.partner_events DROP CONSTRAINT partner_events_check;
ALTER TABLE hamdee_private.partner_events ADD CONSTRAINT partner_events_check
 CHECK((action IN('create-partner','update-partner') AND property_id IS NULL AND entity_id=partner_id)
    OR (action IN('link-property','record-entry','correct-entry') AND property_id IS NOT NULL));
CREATE TABLE hamdee_private.partner_entry_corrections(
 id uuid PRIMARY KEY,original_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.partner_entries(id) ON DELETE RESTRICT,
 replacement_entry_id uuid UNIQUE REFERENCES hamdee_private.partner_entries(id) ON DELETE RESTRICT,
 property_id uuid NOT NULL REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
 partner_id uuid NOT NULL REFERENCES hamdee_private.partners(id) ON DELETE RESTRICT,
 reason varchar(2000) NOT NULL CHECK(length(trim(reason))>0),actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
 corrected_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_id uuid NOT NULL UNIQUE,
 CHECK(replacement_entry_id IS NULL OR replacement_entry_id<>original_entry_id),
 FOREIGN KEY(event_id,partner_id,property_id,id) REFERENCES hamdee_private.partner_events(id,partner_id,property_id,entity_id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX partner_corrections_statement ON hamdee_private.partner_entry_corrections(property_id,partner_id,corrected_at,id);
CREATE FUNCTION hamdee_private.require_partner_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE original hamdee_private.partner_entries;replacement hamdee_private.partner_entries;e hamdee_private.partner_events;replacement_event hamdee_private.partner_events;
BEGIN
 SELECT * INTO original FROM hamdee_private.partner_entries WHERE id=NEW.original_entry_id;
 SELECT * INTO e FROM hamdee_private.partner_events WHERE id=NEW.event_id;
 IF original.id IS NULL OR original.property_id<>NEW.property_id OR original.partner_id<>NEW.partner_id OR NEW.corrected_at<original.recorded_at
 OR NEW.actor_id IS DISTINCT FROM hamdee_private.actor() OR e.id IS NULL OR e.action<>'correct-entry' OR e.actor_id<>NEW.actor_id
 OR e.occurred_at<>NEW.corrected_at OR e.detail->'record' IS DISTINCT FROM (to_jsonb(NEW)-'event_id') THEN RAISE EXCEPTION 'matching retained correction evidence required';END IF;
 IF NEW.replacement_entry_id IS NOT NULL THEN
  SELECT * INTO replacement FROM hamdee_private.partner_entries WHERE id=NEW.replacement_entry_id;
  SELECT * INTO replacement_event FROM hamdee_private.partner_events WHERE id=replacement.event_id;
  IF replacement.id IS NULL OR replacement.property_id<>NEW.property_id OR replacement.partner_id<>NEW.partner_id
  OR replacement.recorded_at<>NEW.corrected_at OR replacement_event.occurred_at<>NEW.corrected_at
  OR replacement_event.detail->>'replacesEntryId' IS DISTINCT FROM original.id::text THEN RAISE EXCEPTION 'atomic same-property/partner replacement evidence required';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER partner_correction_evidence AFTER INSERT ON hamdee_private.partner_entry_corrections DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.require_partner_correction();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.partner_entry_corrections FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
ALTER TABLE hamdee_private.partner_entry_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.partner_entry_corrections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.partner_entry_corrections FROM PUBLIC;
CREATE POLICY partner_correction_owner_read ON hamdee_private.partner_entry_corrections FOR SELECT TO hamdee_runtime USING(hamdee_private.partner_record_owner());
CREATE POLICY partner_correction_owner_insert ON hamdee_private.partner_entry_corrections FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.partner_record_owner() AND actor_id=hamdee_private.actor());
GRANT SELECT,INSERT ON hamdee_private.partner_entry_corrections TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.require_partner_correction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.require_partner_correction() TO hamdee_runtime;
$reviewed_009$;
 source_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''local-test''';
 hosted_guard CONSTANT text := 'app_id=''hamdee'' AND environment=''synthetic-development'' AND project_ref=''jfynuafwsympxxpkqags'' AND data_class=''synthetic_only''';
 base_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties','properties','property_access','property_revisions','audit_events','commands','rental_events','rooms','tenants','rental_agreements','rent_dues','rent_collections','rent_allocations','rental_commands','expense_events','maintenance_jobs','property_expenses','expense_payments','expense_commands','ops_events','ops_collectors','ops_collector_revisions','ops_accounts','ops_receipts','ops_claims','ops_collections','ops_collection_reversals','ops_transfers','ops_money','ops_expense_keys','ops_commands','car_vehicles','car_vehicle_revisions','car_agreements','car_receipts','car_expenses','partners','partner_revisions','property_partners','partner_entries','partner_events','partner_commands'];
 operations_tables CONSTANT text[] := ARRAY['partner_entry_corrections'];
 operations_functions CONSTANT text[] := ARRAY['require_partner_correction'];
 read_only_tables CONSTANT text[] := ARRAY['application_identity','app_users','roles','role_permissions','role_assignments','counterparties'];
 runtime oid; backend oid; schema_id oid; operator_id oid; phase integer; t text; r record;
 before_fingerprints jsonb := '{}'::jsonb; fingerprint text; before_rows jsonb := '{}'::jsonb; row_count bigint; before_catalog jsonb; before_constraints jsonb;
BEGIN
 IF encode(sha256(convert_to(replace(reviewed_source,E'\r\n',E'\n'),'UTF8')),'hex')<>'fda101c08629bd635d07fa08067bf4e090d1625981d1fd50cbfedff697e34dea'
 OR (length(reviewed_source)-length(replace(reviewed_source,source_guard,'')))/length(source_guard)<>1 THEN
  RAISE EXCEPTION 'reviewed local009 digest/guard mismatch'; END IF;
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
  IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables) AND relkind='r')<>47
  OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(ARRAY['ops_claim_placement_date','guard_ops_collector','check_ops_collector','check_ops_account','guard_ops_collection','guard_ops_money','check_ops_money','check_ops_collection_reversal']))<>8
  OR to_regprocedure('hamdee_private.actor()') IS NULL OR to_regprocedure('hamdee_private.can_access(uuid,text)') IS NULL
  OR to_regprocedure('hamdee_private.append_only()') IS NULL OR to_regprocedure('hamdee_private.rental_owner()') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.properties'::regclass AND conname='property_current_revision' AND condeferrable AND condeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.property_revisions'::regclass AND conname='revision_requires_audit' AND condeferrable AND condeferred) THEN
   RAISE EXCEPTION 'reviewed hosted001-004+006+007+008 objects required'; END IF;
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
   IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relkind='r')<>47
   OR to_regclass('hamdee_private.partner_entry_corrections') IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace=schema_id AND typname IN('partner_entry_corrections','_partner_entry_corrections'))
   OR to_regprocedure('hamdee_private.require_partner_correction()') IS NOT NULL
   OR NOT (EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.partner_events'::regclass AND conname='partner_events_action_check' AND pg_get_constraintdef(oid)='CHECK ((action = ANY (ARRAY[''create-partner''::text, ''update-partner''::text, ''link-property''::text, ''record-entry''::text])))')
   AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.partner_events'::regclass AND conname='partner_events_check' AND pg_get_constraintdef(oid)='CHECK ((((action = ANY (ARRAY[''create-partner''::text, ''update-partner''::text])) AND (property_id IS NULL) AND (entity_id = partner_id)) OR ((action = ANY (ARRAY[''link-property''::text, ''record-entry''::text])) AND (property_id IS NOT NULL))))')) THEN RAISE EXCEPTION 'unexpected008 constraint state or existing/partial009 objects';END IF;
   SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    INTO before_catalog FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables);
   SELECT (SELECT jsonb_agg(jsonb_build_array(c.conrelid,c.conname,c.contype,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid)) ORDER BY c.conrelid,c.conname)
    FROM pg_constraint c JOIN pg_class catalog_relation ON catalog_relation.oid=c.conrelid WHERE catalog_relation.relnamespace=schema_id AND catalog_relation.relname=ANY(base_tables)
    AND NOT (catalog_relation.relname='partner_events' AND c.conname IN('partner_events_action_check','partner_events_check'))) INTO before_constraints;
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
   IF (SELECT count(*) FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(operations_tables) AND relkind='r' AND relrowsecurity AND relforcerowsecurity)<>1
   OR (SELECT count(*) FROM pg_proc WHERE pronamespace=schema_id AND proname=ANY(operations_functions))<>1 THEN
    RAISE EXCEPTION 'partner009 installation incomplete'; END IF;
   IF before_catalog IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE relnamespace=schema_id AND relname=ANY(base_tables)) THEN
    RAISE EXCEPTION 'base table identity/permissions changed'; END IF;
   IF before_constraints IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(c.conrelid,c.conname,c.contype,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid)) ORDER BY c.conrelid,c.conname)
    FROM pg_constraint c JOIN pg_class catalog_relation ON catalog_relation.oid=c.conrelid WHERE catalog_relation.relnamespace=schema_id AND catalog_relation.relname=ANY(base_tables)
    AND NOT (catalog_relation.relname='partner_events' AND c.conname IN('partner_events_action_check','partner_events_check'))) OR NOT (EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.partner_events'::regclass AND conname='partner_events_action_check' AND pg_get_constraintdef(oid)='CHECK ((action = ANY (ARRAY[''create-partner''::text, ''update-partner''::text, ''link-property''::text, ''record-entry''::text, ''correct-entry''::text])))')
   AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hamdee_private.partner_events'::regclass AND conname='partner_events_check' AND pg_get_constraintdef(oid)='CHECK ((((action = ANY (ARRAY[''create-partner''::text, ''update-partner''::text])) AND (property_id IS NULL) AND (entity_id = partner_id)) OR ((action = ANY (ARRAY[''link-property''::text, ''record-entry''::text, ''correct-entry''::text])) AND (property_id IS NOT NULL))))')) THEN RAISE EXCEPTION 'unexpected base constraint change outside reviewed009 action checks';END IF;
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
END $hosted_partner_corrections$;
COMMIT;
