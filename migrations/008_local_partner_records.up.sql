-- Migration 008: disposable LOCAL HAMDEE only. Hosted execution requires the separate reviewed wrapper.
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
