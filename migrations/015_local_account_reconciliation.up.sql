-- Additive disposable-local artifact only. No automatic hosted application.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'disposable local HAMDEE schema required'; END IF;
END $$;
CREATE TABLE hamdee_private.account_reconciliations(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES hamdee_private.ops_accounts(id) ON DELETE RESTRICT,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),reconciled_date date NOT NULL,
 calculated_balance numeric NOT NULL,counted_balance numeric NOT NULL CHECK(counted_balance>=0 AND counted_balance<1000000000000000000 AND scale(counted_balance)<=12),
 difference numeric NOT NULL,explanation varchar(2000) NOT NULL CHECK(length(trim(explanation))>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(difference=counted_balance-calculated_balance)
);
CREATE INDEX account_reconciliation_date ON hamdee_private.account_reconciliations(account_id,reconciled_date);
ALTER TABLE hamdee_private.account_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.account_reconciliations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.account_reconciliations FROM PUBLIC;
GRANT SELECT,INSERT ON hamdee_private.account_reconciliations TO hamdee_runtime;
CREATE POLICY reconciliation_owner_read ON hamdee_private.account_reconciliations FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
CREATE POLICY reconciliation_owner_insert ON hamdee_private.account_reconciliations FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner());
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.account_reconciliations FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();
CREATE FUNCTION hamdee_private.check_account_reconciliation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.ops_accounts a WHERE a.id=NEW.account_id AND a.currency=NEW.currency AND a.opening_date<=NEW.reconciled_date)
 OR NEW.calculated_balance<>(SELECT coalesce(sum(delta),0) FROM hamdee_private.ops_money WHERE account_id=NEW.account_id AND business_date<=NEW.reconciled_date)
 THEN RAISE EXCEPTION 'exact same-currency dated account comparison required';END IF;RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_evidence BEFORE INSERT ON hamdee_private.account_reconciliations FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_account_reconciliation();
REVOKE ALL ON FUNCTION hamdee_private.check_account_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_account_reconciliation() TO hamdee_runtime;
