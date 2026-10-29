-- Disposable local test only; hosted execution requires the separately reviewed wrapper.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.rooms') IS NULL THEN RAISE EXCEPTION 'local HAMDEE rental schema required'; END IF;
END $$;

CREATE TABLE hamdee_private.property_documents (
 id uuid PRIMARY KEY,
 property_id uuid NOT NULL REFERENCES hamdee_private.properties(id) ON DELETE RESTRICT,
 room_id uuid,
 name varchar(200) NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 1048576),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL REFERENCES hamdee_private.app_users(id) ON DELETE RESTRICT,
 command_key uuid NOT NULL,
 command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,command_key),
 FOREIGN KEY(room_id,property_id) REFERENCES hamdee_private.rooms(id,property_id) ON DELETE RESTRICT
);
CREATE INDEX property_documents_listing ON hamdee_private.property_documents(property_id,id);
CREATE TRIGGER property_documents_immutable BEFORE UPDATE OR DELETE ON hamdee_private.property_documents
 FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
ALTER TABLE hamdee_private.property_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.property_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.property_documents FROM PUBLIC;
CREATE POLICY property_documents_owner_read ON hamdee_private.property_documents FOR SELECT TO hamdee_runtime
 USING(hamdee_private.rental_owner());
CREATE POLICY property_documents_owner_insert ON hamdee_private.property_documents FOR INSERT TO hamdee_runtime
 WITH CHECK(hamdee_private.rental_owner() AND actor_id=hamdee_private.actor());
GRANT SELECT, INSERT ON hamdee_private.property_documents TO hamdee_runtime;
