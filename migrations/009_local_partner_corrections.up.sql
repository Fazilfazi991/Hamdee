-- Disposable LOCAL only. Reviewed hosted execution requires a separate wrapper.
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
