-- Disposable local test only; prepare and review a separate hosted wrapper.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.car_vehicles') IS NULL THEN RAISE EXCEPTION 'local HAMDEE car schema required'; END IF;
END $$;

-- Preserve existing registration uniqueness and all previous vehicle revisions.
ALTER TABLE hamdee_private.car_vehicles ALTER COLUMN registration DROP NOT NULL;
ALTER TABLE hamdee_private.car_vehicles ALTER COLUMN make DROP NOT NULL;
ALTER TABLE hamdee_private.car_vehicles DROP CONSTRAINT car_vehicles_status_check;
ALTER TABLE hamdee_private.car_vehicles ADD CONSTRAINT car_vehicles_status_check
 CHECK(status IN ('active','maintenance','inactive','needs_confirmation'));

-- Exact source keys prevent duplicates; text is an unposted historical reference,
-- not a financial event, a confirmed rental term, or evidence of current use.
CREATE TABLE hamdee_private.car_source_references (
 id uuid PRIMARY KEY,
 vehicle_id uuid NOT NULL REFERENCES hamdee_private.car_vehicles(id) ON DELETE RESTRICT,
 source_key varchar(240) NOT NULL UNIQUE CHECK(length(trim(source_key))>0),
 source_reference varchar(1000) NOT NULL CHECK(length(trim(source_reference))>0),
 amount_reference varchar(100) NOT NULL DEFAULT '',
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX car_source_vehicle ON hamdee_private.car_source_references(vehicle_id,id);
CREATE TRIGGER car_source_immutable BEFORE UPDATE OR DELETE ON hamdee_private.car_source_references
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
ALTER TABLE hamdee_private.car_source_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.car_source_references FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.car_source_references FROM PUBLIC;
CREATE POLICY car_source_read ON hamdee_private.car_source_references FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
CREATE POLICY car_source_insert ON hamdee_private.car_source_references FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner());
GRANT SELECT,INSERT ON hamdee_private.car_source_references TO hamdee_runtime;
