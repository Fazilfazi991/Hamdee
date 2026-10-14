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
