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
