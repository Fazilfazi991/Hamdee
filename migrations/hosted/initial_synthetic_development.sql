-- PROPOSED ONLY. Not applied to Supabase. Approval required before execution.
-- Exact target: dytlzfwbgeuhzgzemqsf, Singapore, synthetic development only.
-- Execute through an explicitly project-scoped migration operator; SQL cannot
-- independently prove the hosting project from a generic postgres database.
-- Historical local-only comments in the copied source sections remain intact.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('hamdee-initial-synthetic-development-schema',0));
DO $$ BEGIN
 IF current_database()<>'postgres' OR current_setting('server_version_num')::int<170000 THEN
  RAISE EXCEPTION 'unreviewed database or PostgreSQL version';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='hamdee_private')
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('hamdee_runtime','hamdee_backend'))
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) THEN
  RAISE EXCEPTION 'source snapshot changed: stop rather than overwrite existing objects';
 END IF;
END $$;
-- Generic PostgreSQL migration. TASK 004: disposable local databases ONLY.
-- No Supabase/hosted migration has been applied. No users or credentials seeded.
CREATE SCHEMA hamdee_private;
REVOKE ALL ON SCHEMA hamdee_private FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hamdee_runtime') THEN
    CREATE ROLE hamdee_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
CREATE TABLE hamdee_private.application_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  app_id text NOT NULL CHECK(app_id='hamdee'),
  environment text NOT NULL CHECK(environment='local-test')
);
INSERT INTO hamdee_private.application_identity VALUES(true,'hamdee','local-test');
CREATE TABLE hamdee_private.app_users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE(issuer,subject)
);
CREATE TABLE hamdee_private.roles (code text PRIMARY KEY CHECK(code IN ('admin','finance','operations','read_only')));
INSERT INTO hamdee_private.roles VALUES ('admin'),('finance'),('operations'),('read_only');
CREATE TABLE hamdee_private.role_permissions (
  role text REFERENCES hamdee_private.roles(code) ON DELETE RESTRICT,
  capability text CHECK(capability IN ('read','create','update','archive','restore','audit')),
  PRIMARY KEY(role,capability)
);
INSERT INTO hamdee_private.role_permissions VALUES
 ('admin','read'),('admin','create'),('admin','update'),('admin','archive'),('admin','restore'),('admin','audit'),
 ('operations','read'),('operations','create'),('operations','update'),
 ('finance','read'),('finance','audit'),('read_only','read');
CREATE TABLE hamdee_private.role_assignments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  role text NOT NULL REFERENCES hamdee_private.roles(code) ON DELETE RESTRICT,
  portfolio boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  UNIQUE(user_id,role)
);
CREATE INDEX role_assignments_user ON hamdee_private.role_assignments(user_id);
CREATE TABLE hamdee_private.counterparties (
  id uuid PRIMARY KEY,
  display_name varchar(200) NOT NULL CHECK(length(trim(display_name))>0)
);
CREATE TABLE hamdee_private.properties (
  id uuid PRIMARY KEY,
  name varchar(200) NOT NULL CHECK(length(trim(name))>0),
  location varchar(500),
  counterparty_id uuid REFERENCES hamdee_private.counterparties(id) ON DELETE RESTRICT,
  lifecycle_status text NOT NULL DEFAULT 'registered' CHECK(lifecycle_status IN ('registered','archived')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  archived_at timestamptz,
  archived_by uuid REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  archive_reason varchar(500),
  CHECK ((lifecycle_status='registered' AND archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
    OR (lifecycle_status='archived' AND archived_at IS NOT NULL AND archived_by IS NOT NULL AND length(trim(archive_reason))>0))
);
CREATE INDEX properties_counterparty ON hamdee_private.properties(counterparty_id);
CREATE INDEX properties_list ON hamdee_private.properties(lifecycle_status,created_at,id);
CREATE TABLE hamdee_private.property_access (
  assignment_id uuid REFERENCES hamdee_private.role_assignments(id) ON DELETE RESTRICT,
  property_id uuid REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
  PRIMARY KEY(assignment_id,property_id)
);
CREATE INDEX property_access_property ON hamdee_private.property_access(property_id);
CREATE TABLE hamdee_private.property_revisions (
  property_id uuid REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
  version integer CHECK(version>0),
  profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
  actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(property_id,version)
);
CREATE TABLE hamdee_private.audit_events (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('create','update','archive','restore')),
  reason varchar(500),
  changed_fields text[] NOT NULL,
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(property_id,version),
  FOREIGN KEY(property_id,version) REFERENCES hamdee_private.property_revisions(property_id,version) ON DELETE RESTRICT
);
CREATE INDEX audit_events_property ON hamdee_private.audit_events(property_id,occurred_at,id);
CREATE TABLE hamdee_private.commands (
  actor_id uuid REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  target text NOT NULL,
  key uuid NOT NULL,
  digest text NOT NULL CHECK(length(digest)=64),
  property_id uuid NOT NULL REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,operation,target,key)
);
CREATE INDEX commands_property ON hamdee_private.commands(property_id);
CREATE FUNCTION hamdee_private.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
 SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('hamdee.actor',true),'')::uuid $$;
CREATE FUNCTION hamdee_private.can_access(pid uuid, cap text) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
 SET search_path=pg_catalog AS $$
 SELECT EXISTS (
   SELECT 1 FROM hamdee_private.app_users u
   JOIN hamdee_private.role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
   JOIN hamdee_private.role_permissions rp ON rp.role=a.role AND rp.capability=cap
   WHERE u.id=hamdee_private.actor() AND u.enabled
     AND ((cap='create' AND (a.portfolio OR a.role='operations')) OR (cap<>'create' AND a.portfolio) OR (cap<>'create' AND EXISTS(
       SELECT 1 FROM hamdee_private.property_access pa WHERE pa.assignment_id=a.id AND pa.property_id=pid))
     )
 ) $$;
CREATE FUNCTION hamdee_private.append_only() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'append-only history'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON hamdee_private.audit_events
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
CREATE TRIGGER revision_append_only BEFORE UPDATE OR DELETE ON hamdee_private.property_revisions
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
CREATE TRIGGER command_append_only BEFORE UPDATE OR DELETE ON hamdee_private.commands
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();

ALTER TABLE hamdee_private.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.properties FORCE ROW LEVEL SECURITY;
CREATE POLICY property_read ON hamdee_private.properties FOR SELECT TO hamdee_runtime
 USING(hamdee_private.can_access(id,'read') OR (current_setting('hamdee.action',true)='create' AND created_by=hamdee_private.actor() AND hamdee_private.can_access(id,'create')));
CREATE POLICY property_create ON hamdee_private.properties FOR INSERT TO hamdee_runtime
 WITH CHECK(current_setting('hamdee.action',true)='create' AND hamdee_private.can_access(id,'create') AND created_by=hamdee_private.actor() AND updated_by=hamdee_private.actor());
CREATE POLICY property_update ON hamdee_private.properties FOR UPDATE TO hamdee_runtime
 USING(current_setting('hamdee.action',true) IN ('update','archive','restore') AND hamdee_private.can_access(id,current_setting('hamdee.action',true)))
 WITH CHECK(current_setting('hamdee.action',true) IN ('update','archive','restore') AND hamdee_private.can_access(id,current_setting('hamdee.action',true)) AND updated_by=hamdee_private.actor());
ALTER TABLE hamdee_private.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON hamdee_private.audit_events FOR SELECT TO hamdee_runtime USING(hamdee_private.can_access(property_id,'audit'));
CREATE POLICY audit_insert ON hamdee_private.audit_events FOR INSERT TO hamdee_runtime WITH CHECK(actor_id=hamdee_private.actor() AND action=current_setting('hamdee.action',true) AND hamdee_private.can_access(property_id,action));
ALTER TABLE hamdee_private.property_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY revision_read ON hamdee_private.property_revisions FOR SELECT TO hamdee_runtime USING(hamdee_private.can_access(property_id,'audit'));
CREATE POLICY revision_insert ON hamdee_private.property_revisions FOR INSERT TO hamdee_runtime WITH CHECK(actor_id=hamdee_private.actor() AND current_setting('hamdee.action',true) IN ('create','update','archive','restore') AND hamdee_private.can_access(property_id,current_setting('hamdee.action',true)));
ALTER TABLE hamdee_private.commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY command_read ON hamdee_private.commands FOR SELECT TO hamdee_runtime USING(actor_id=hamdee_private.actor());
CREATE POLICY command_insert ON hamdee_private.commands FOR INSERT TO hamdee_runtime WITH CHECK(actor_id=hamdee_private.actor() AND hamdee_private.can_access(property_id,'read'));

REVOKE ALL ON ALL TABLES IN SCHEMA hamdee_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hamdee_private FROM PUBLIC;
GRANT USAGE ON SCHEMA hamdee_private TO hamdee_runtime;
GRANT SELECT ON hamdee_private.application_identity,hamdee_private.app_users,hamdee_private.roles,hamdee_private.role_permissions,hamdee_private.role_assignments,hamdee_private.property_access,hamdee_private.counterparties TO hamdee_runtime;
GRANT SELECT,INSERT ON hamdee_private.properties TO hamdee_runtime;
GRANT UPDATE(name,location,counterparty_id,lifecycle_status,updated_at,updated_by,version,archived_at,archived_by,archive_reason) ON hamdee_private.properties TO hamdee_runtime;
GRANT SELECT,INSERT ON hamdee_private.audit_events,hamdee_private.property_revisions,hamdee_private.commands TO hamdee_runtime;
GRANT INSERT ON hamdee_private.property_access TO hamdee_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hamdee_private TO hamdee_runtime;
ALTER TABLE hamdee_private.property_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_read ON hamdee_private.property_access FOR SELECT TO hamdee_runtime USING(EXISTS(SELECT 1 FROM hamdee_private.role_assignments a WHERE a.id=assignment_id AND a.user_id=hamdee_private.actor()));
-- A scoped operations creator receives access only through its own active grant
-- to the property just created by that actor; never portfolio access.
CREATE POLICY creator_access ON hamdee_private.property_access FOR INSERT TO hamdee_runtime WITH CHECK(
 current_setting('hamdee.action',true)='create' AND EXISTS(
  SELECT 1 FROM hamdee_private.role_assignments a WHERE a.id=assignment_id AND a.user_id=hamdee_private.actor()
   AND a.role='operations' AND NOT a.portfolio AND a.revoked_at IS NULL
 ) AND EXISTS(SELECT 1 FROM hamdee_private.properties p WHERE p.id=property_id AND p.created_by=hamdee_private.actor() AND p.version=1)
);

-- Generic PostgreSQL, NOT a Supabase CLI migration. Disposable local HAMDEE only.
-- Apply after 001 in one transaction. No financial rules or data corrections.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'not an isolated HAMDEE local-test schema';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hamdee_runtime' AND
   (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
  RAISE EXCEPTION 'unsafe existing HAMDEE runtime role';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hamdee_runtime')) THEN
  RAISE EXCEPTION 'unsafe existing HAMDEE runtime role membership';
 END IF;
END $$;

ALTER TABLE hamdee_private.properties ADD CONSTRAINT archive_reason_present CHECK(
 lifecycle_status<>'archived' OR (archive_reason IS NOT NULL AND length(trim(archive_reason))>0));
ALTER TABLE hamdee_private.commands ADD CONSTRAINT command_operation CHECK(operation IN ('create','update','archive','restore'));
ALTER TABLE hamdee_private.commands ADD CONSTRAINT command_digest CHECK(digest ~ '^[0-9a-f]{64}$');

-- Deferred relational evidence prevents any committed property version lacking
-- its revision and matching audit event, even via direct runtime-role SQL.
ALTER TABLE hamdee_private.properties ADD CONSTRAINT property_current_revision
 FOREIGN KEY(id,version) REFERENCES hamdee_private.property_revisions(property_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE hamdee_private.property_revisions ADD CONSTRAINT revision_requires_audit
 FOREIGN KEY(property_id,version) REFERENCES hamdee_private.audit_events(property_id,version) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION hamdee_private.guard_property_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog AS $$
DECLARE action text:=current_setting('hamdee.action',true);
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.lifecycle_status<>'registered' THEN RAISE EXCEPTION 'invalid initial property revision'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'immutable identity or invalid revision'; END IF;
 IF action='update' THEN
  IF OLD.lifecycle_status<>'registered' OR NEW.lifecycle_status<>'registered'
   OR ROW(NEW.archived_at,NEW.archived_by,NEW.archive_reason) IS DISTINCT FROM ROW(OLD.archived_at,OLD.archived_by,OLD.archive_reason)
   THEN RAISE EXCEPTION 'metadata update cannot archive'; END IF;
 ELSIF action IN ('archive','restore') THEN
  IF ROW(NEW.name,NEW.location,NEW.counterparty_id) IS DISTINCT FROM ROW(OLD.name,OLD.location,OLD.counterparty_id)
   OR (action='archive' AND (OLD.lifecycle_status<>'registered' OR NEW.lifecycle_status<>'archived'))
   OR (action='restore' AND (OLD.lifecycle_status<>'archived' OR NEW.lifecycle_status<>'registered'))
   THEN RAISE EXCEPTION 'invalid archive transition'; END IF;
 ELSE RAISE EXCEPTION 'property mutation context required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hamdee_private.guard_property_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_property_change() TO hamdee_runtime;
CREATE TRIGGER property_change_guard BEFORE INSERT OR UPDATE ON hamdee_private.properties
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_property_change();

-- Creation exceptions apply only to the one new UUID in this transaction.
DROP POLICY property_read ON hamdee_private.properties;
CREATE POLICY property_read ON hamdee_private.properties FOR SELECT TO hamdee_runtime USING(
 hamdee_private.can_access(id,'read') OR (current_setting('hamdee.action',true)='create'
 AND id=nullif(current_setting('hamdee.new_property',true),'')::uuid AND version=1
 AND created_by=hamdee_private.actor() AND hamdee_private.can_access(id,'create')));
DROP POLICY creator_access ON hamdee_private.property_access;
CREATE POLICY creator_access ON hamdee_private.property_access FOR INSERT TO hamdee_runtime WITH CHECK(
 current_setting('hamdee.action',true)='create' AND property_id=nullif(current_setting('hamdee.new_property',true),'')::uuid
 AND EXISTS(SELECT 1 FROM hamdee_private.role_assignments a WHERE a.id=assignment_id
  AND a.user_id=hamdee_private.actor() AND a.role='operations' AND NOT a.portfolio AND a.revoked_at IS NULL)
 AND EXISTS(SELECT 1 FROM hamdee_private.properties p WHERE p.id=property_id AND p.created_by=hamdee_private.actor() AND p.version=1));
REVOKE INSERT ON hamdee_private.properties FROM hamdee_runtime;
GRANT INSERT(id,name,location,counterparty_id,created_by,updated_by) ON hamdee_private.properties TO hamdee_runtime;
CREATE INDEX properties_status_id ON hamdee_private.properties(lifecycle_status,id);
-- No weakening down migration: forward-fix or reset the entire disposable DB.

-- Additive generic PostgreSQL migration for disposable local HAMDEE testing.
-- Not hosted authorization. No seed identities/data or recognition rules.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'local HAMDEE schema required'; END IF;
END $$;
CREATE TABLE hamdee_private.rental_events (
 id uuid PRIMARY KEY, property_id uuid REFERENCES hamdee_private.properties(id), room_id uuid,
 entity_id uuid NOT NULL, action text NOT NULL, detail jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hamdee_private.rooms (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES hamdee_private.properties(id),
 code varchar(40) NOT NULL CHECK(code=upper(trim(code)) AND length(code)>0), label varchar(200) NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0), event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(property_id,code), UNIQUE(id,property_id)
);
CREATE TABLE hamdee_private.tenants (
 id uuid PRIMARY KEY, name varchar(200) NOT NULL CHECK(length(trim(name))>0),
 phone varchar(60) NOT NULL DEFAULT '', email varchar(254) NOT NULL DEFAULT '', notes varchar(1000) NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0), event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hamdee_private.rental_agreements (
 id uuid PRIMARY KEY, property_id uuid NOT NULL, room_id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES hamdee_private.tenants(id),
 start_date date NOT NULL, end_date date CHECK(end_date>=start_date), monthly_rent_minor bigint NOT NULL CHECK(monthly_rent_minor>0 AND monthly_rent_minor<=999999999999),
 deposit_required_minor bigint NOT NULL CHECK(deposit_required_minor>=0 AND deposit_required_minor<=999999999999),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), due_terms varchar(200) NOT NULL CHECK(length(trim(due_terms))>0),
 previous_agreement_id uuid REFERENCES hamdee_private.rental_agreements(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id), UNIQUE(id,room_id,property_id,currency)
);
CREATE INDEX rental_agreement_room_dates ON hamdee_private.rental_agreements(room_id,start_date,end_date);
CREATE TABLE hamdee_private.rent_dues (
 id uuid PRIMARY KEY, agreement_id uuid NOT NULL, room_id uuid NOT NULL, property_id uuid NOT NULL, currency text NOT NULL,
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), due_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=999999999999), snapshot jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(agreement_id,room_id,property_id,currency) REFERENCES hamdee_private.rental_agreements(id,room_id,property_id,currency),
 UNIQUE(agreement_id,period), UNIQUE(id,agreement_id,currency), CHECK(to_char(due_date,'YYYY-MM')=period)
);
CREATE TABLE hamdee_private.rent_collections (
 id uuid PRIMARY KEY, agreement_id uuid NOT NULL, room_id uuid NOT NULL, property_id uuid NOT NULL, currency text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('rent','advance','deposit','deposit_refund')), method text NOT NULL CHECK(method IN ('cash','bank','cheque')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=999999999999), received_date date NOT NULL,
 reference varchar(200) NOT NULL DEFAULT '', status text NOT NULL CHECK(status IN ('recorded','pending')),
 event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(agreement_id,room_id,property_id,currency) REFERENCES hamdee_private.rental_agreements(id,room_id,property_id,currency),
 UNIQUE(id,agreement_id,currency), CHECK((method='cheque' AND status='pending') OR (method<>'cheque' AND status='recorded')),
 CHECK(kind<>'deposit_refund' OR method<>'cheque')
);
CREATE TABLE hamdee_private.rent_allocations (
 id uuid PRIMARY KEY, collection_id uuid NOT NULL, due_id uuid NOT NULL, agreement_id uuid NOT NULL, currency text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), allocated_date date NOT NULL, event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(collection_id,agreement_id,currency) REFERENCES hamdee_private.rent_collections(id,agreement_id,currency),
 FOREIGN KEY(due_id,agreement_id,currency) REFERENCES hamdee_private.rent_dues(id,agreement_id,currency)
);
CREATE INDEX rent_allocation_due ON hamdee_private.rent_allocations(due_id);
CREATE INDEX rent_allocation_receipt ON hamdee_private.rent_allocations(collection_id);
CREATE TABLE hamdee_private.rental_commands (
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id), key uuid NOT NULL, digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL, PRIMARY KEY(actor_id,key)
);
CREATE FUNCTION hamdee_private.rental_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM hamdee_private.app_users u JOIN hamdee_private.role_assignments a ON a.user_id=u.id
 WHERE u.id=hamdee_private.actor() AND u.enabled AND a.role='admin' AND a.portfolio AND a.revoked_at IS NULL)
$$;
CREATE FUNCTION hamdee_private.guard_rental_agreement() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rental-room:'||NEW.room_id::text,0));
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['end_date','version','event_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['end_date','version','event_id']) THEN
  RAISE EXCEPTION 'agreement terms immutable; renew with a new agreement'; END IF;
 IF TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid agreement revision'; END IF;
 IF NEW.previous_agreement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hamdee_private.rental_agreements a
  WHERE a.id=NEW.previous_agreement_id AND a.room_id=NEW.room_id AND a.end_date<NEW.start_date) THEN RAISE EXCEPTION 'invalid renewal link'; END IF;
 IF EXISTS(SELECT 1 FROM hamdee_private.rental_agreements a WHERE a.room_id=NEW.room_id AND a.id<>NEW.id
  AND a.start_date<=coalesce(NEW.end_date,'infinity'::date) AND coalesce(a.end_date,'infinity'::date)>=NEW.start_date) THEN
  RAISE EXCEPTION 'overlapping room agreement'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agreement_guard BEFORE INSERT OR UPDATE ON hamdee_private.rental_agreements FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_rental_agreement();
CREATE FUNCTION hamdee_private.guard_rent_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE receipt hamdee_private.rent_collections; due hamdee_private.rent_dues;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rental-allocation:'||NEW.agreement_id::text,0));
 SELECT * INTO receipt FROM hamdee_private.rent_collections WHERE id=NEW.collection_id;
 SELECT * INTO due FROM hamdee_private.rent_dues WHERE id=NEW.due_id;
 IF receipt.id IS NULL OR due.id IS NULL THEN RAISE EXCEPTION 'allocation reference unavailable'; END IF;
 IF NEW.allocated_date<receipt.received_date THEN RAISE EXCEPTION 'allocation precedes receipt'; END IF;
 IF receipt.status<>'recorded' OR receipt.kind NOT IN ('rent','advance') THEN RAISE EXCEPTION 'receipt not allocatable'; END IF;
 IF NEW.amount_minor+coalesce((SELECT sum(amount_minor) FROM hamdee_private.rent_allocations WHERE collection_id=receipt.id),0)>receipt.amount_minor
  OR NEW.amount_minor+coalesce((SELECT sum(amount_minor) FROM hamdee_private.rent_allocations WHERE due_id=due.id),0)>due.amount_minor THEN
  RAISE EXCEPTION 'allocation exceeds receipt or obligation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_guard BEFORE INSERT ON hamdee_private.rent_allocations FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_rent_allocation();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rental_events','rooms','tenants','rental_agreements','rent_dues','rent_collections','rent_allocations','rental_commands'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
  EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
  EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  IF t IN ('rooms','tenants','rental_agreements') THEN
   EXECUTE format('CREATE POLICY owner_update ON hamdee_private.%I FOR UPDATE TO hamdee_runtime USING(hamdee_private.rental_owner()) WITH CHECK(hamdee_private.rental_owner())',t);
  ELSE
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
  END IF;
 END LOOP;
END $$;
GRANT UPDATE(code,label,version,event_id) ON hamdee_private.rooms TO hamdee_runtime;
GRANT UPDATE(name,phone,email,notes,version,event_id) ON hamdee_private.tenants TO hamdee_runtime;
GRANT UPDATE(end_date,version,event_id) ON hamdee_private.rental_agreements TO hamdee_runtime;
CREATE FUNCTION hamdee_private.guard_rental_revision() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version<>OLD.version+1 OR NEW.event_id=OLD.event_id THEN
  RAISE EXCEPTION 'immutable identity, sequential revision and new history required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_revision BEFORE UPDATE ON hamdee_private.rooms FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_rental_revision();
CREATE TRIGGER tenant_revision BEFORE UPDATE ON hamdee_private.tenants FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_rental_revision();
CREATE TRIGGER agreement_revision BEFORE UPDATE ON hamdee_private.rental_agreements FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_rental_revision();
DROP POLICY owner_insert ON hamdee_private.rental_events;
CREATE POLICY owner_insert ON hamdee_private.rental_events FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
DROP POLICY owner_insert ON hamdee_private.rental_commands;
CREATE POLICY owner_insert ON hamdee_private.rental_commands FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
REVOKE ALL ON FUNCTION hamdee_private.guard_rental_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_rental_revision() TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.rental_owner(),hamdee_private.guard_rental_agreement(),hamdee_private.guard_rent_allocation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.rental_owner(),hamdee_private.guard_rental_agreement(),hamdee_private.guard_rent_allocation() TO hamdee_runtime;

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

-- The temporary local-test marker was needed only for the unchanged 002/003/004
-- hardening checks. It is converted before this transaction can commit.
ALTER TABLE hamdee_private.application_identity DROP CONSTRAINT application_identity_environment_check;
ALTER TABLE hamdee_private.application_identity ADD COLUMN project_ref text, ADD COLUMN data_class text;
UPDATE hamdee_private.application_identity SET environment='synthetic-development',
 project_ref='dytlzfwbgeuhzgzemqsf',data_class='synthetic_only';
ALTER TABLE hamdee_private.application_identity ALTER COLUMN project_ref SET NOT NULL;
ALTER TABLE hamdee_private.application_identity ALTER COLUMN data_class SET NOT NULL;
ALTER TABLE hamdee_private.application_identity ADD CONSTRAINT hamdee_development_environment CHECK(environment='synthetic-development');
ALTER TABLE hamdee_private.application_identity ADD CONSTRAINT hamdee_development_project CHECK(project_ref='dytlzfwbgeuhzgzemqsf');
ALTER TABLE hamdee_private.application_identity ADD CONSTRAINT hamdee_development_data CHECK(data_class='synthetic_only');

-- Keep all provider-managed roles/settings and existing schemas unchanged.
REVOKE ALL ON SCHEMA hamdee_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA hamdee_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hamdee_private FROM PUBLIC,anon,authenticated,service_role;
ALTER ROLE hamdee_runtime NOINHERIT;
-- Provision the secret and LOGIN separately through authorized secure setup.
-- This review artifact contains no password and enables no database login.
CREATE ROLE hamdee_backend NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE postgres TO hamdee_backend;
GRANT hamdee_runtime TO hamdee_backend WITH ADMIN FALSE;
GRANT hamdee_runtime TO hamdee_backend WITH INHERIT FALSE;
GRANT hamdee_runtime TO hamdee_backend WITH SET TRUE;
-- A non-superuser role creator may set NOINHERIT, but may not redundantly
-- ALTER SUPERUSER/BYPASSRLS/REPLICATION even to their existing false values.
-- Creation and 002 already require safe roles; assert the complete final state.
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('hamdee_runtime','hamdee_backend')
  AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls
   OR rolcreatedb OR rolcreaterole OR rolreplication))<>2 THEN
  RAISE EXCEPTION 'unsafe final HAMDEE application role attributes';
 END IF;
END $$;
-- No application member, owner account, property or financial record is seeded.
COMMIT;
