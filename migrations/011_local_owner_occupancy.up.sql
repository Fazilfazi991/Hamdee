-- Additive local review only. Hosted application requires separate approval.
-- Supabase CLI is unavailable in this workspace; retain the existing numbered convention.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'local HAMDEE schema required'; END IF;
END $$;
-- Unknown deposit requirements remain NULL, distinct from an owner-confirmed zero.
-- Actual received/refunded deposits are governed by immutable receipts, not this term.
ALTER TABLE hamdee_private.rental_agreements ALTER COLUMN deposit_required_minor DROP NOT NULL;
CREATE TABLE hamdee_private.room_occupancy_confirmations (
 id uuid PRIMARY KEY, property_id uuid NOT NULL, room_id uuid NOT NULL,
 tenant_id uuid REFERENCES hamdee_private.tenants(id), status text NOT NULL CHECK(status IN ('occupied','vacant','unknown')),
 effective_date date NOT NULL, version integer NOT NULL CHECK(version>0), notes varchar(1000) NOT NULL DEFAULT '',
 agreement_id uuid REFERENCES hamdee_private.rental_agreements(id),
 event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id), UNIQUE(room_id,version),
 CHECK((status='occupied' AND tenant_id IS NOT NULL) OR (status<>'occupied' AND tenant_id IS NULL)),
 CHECK(agreement_id IS NULL OR status='occupied')
);
CREATE INDEX room_occupancy_effective ON hamdee_private.room_occupancy_confirmations(room_id,effective_date,version);
CREATE TABLE hamdee_private.source_roster_confirmations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hamdee_private.tenants(id), room_id uuid REFERENCES hamdee_private.rooms(id),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 source_reference varchar(500) NOT NULL CHECK(length(trim(source_reference))>0),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), notes varchar(1000) NOT NULL DEFAULT '',
 event_id uuid NOT NULL REFERENCES hamdee_private.rental_events(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX source_roster_unique ON hamdee_private.source_roster_confirmations(source_sha256,period,tenant_id,coalesce(room_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE FUNCTION hamdee_private.guard_owner_occupancy() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE previous hamdee_private.room_occupancy_confirmations;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rental-room:'||NEW.room_id::text,0));
 SELECT * INTO previous FROM hamdee_private.room_occupancy_confirmations WHERE room_id=NEW.room_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>coalesce(previous.version,0)+1 OR (previous.id IS NOT NULL AND NEW.effective_date<previous.effective_date) THEN
  RAISE EXCEPTION 'sequential occupancy confirmation and nondecreasing effective date required'; END IF;
 IF NEW.agreement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hamdee_private.rental_agreements a WHERE a.id=NEW.agreement_id AND a.room_id=NEW.room_id
  AND a.property_id=NEW.property_id AND a.tenant_id=NEW.tenant_id AND a.start_date<=NEW.effective_date AND (a.end_date IS NULL OR a.end_date>=NEW.effective_date)) THEN
  RAISE EXCEPTION 'occupancy terms do not match the confirmed occupant and date'; END IF;
 IF EXISTS(SELECT 1 FROM hamdee_private.rental_agreements a WHERE a.room_id=NEW.room_id AND a.start_date<=NEW.effective_date
  AND (a.end_date IS NULL OR a.end_date>=NEW.effective_date) AND (NEW.status<>'occupied' OR a.tenant_id IS DISTINCT FROM NEW.tenant_id)) THEN
  RAISE EXCEPTION 'end conflicting rental terms explicitly before occupancy confirmation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER occupancy_guard BEFORE INSERT ON hamdee_private.room_occupancy_confirmations FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_owner_occupancy();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['room_occupancy_confirmations','source_roster_confirmations'] LOOP
  EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
  EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
  EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM authenticated',t); END IF;
  EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION hamdee_private.guard_owner_occupancy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_owner_occupancy() TO hamdee_runtime;
