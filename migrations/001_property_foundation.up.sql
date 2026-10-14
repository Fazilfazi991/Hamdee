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
