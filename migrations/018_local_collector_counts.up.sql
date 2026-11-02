-- Additive local rehearsal only; destination-specific hosted plan is separate.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.account_reconciliations') IS NULL THEN RAISE EXCEPTION 'local reconciliation baseline required';END IF;
END $$;
ALTER TABLE hamdee_private.account_reconciliations ADD COLUMN count_details jsonb CHECK(count_details IS NULL OR jsonb_typeof(count_details)='array');
CREATE TABLE hamdee_private.collector_openings(
 collector_id uuid NOT NULL REFERENCES hamdee_private.ops_collectors(id),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 opening_date date NOT NULL,opening_amount numeric NOT NULL CHECK(opening_amount>=0 AND opening_amount<1000000000000000000 AND scale(opening_amount)<=12),method text NOT NULL CHECK(method IN ('cash','bank')),
 owner_confirmed boolean NOT NULL CHECK(owner_confirmed),source_reference varchar(500) NOT NULL,notes varchar(2000) NOT NULL DEFAULT '',
 money_entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) DEFERRABLE INITIALLY DEFERRED,
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(collector_id,currency)
);
CREATE TABLE hamdee_private.collector_reconciliations(
 id uuid PRIMARY KEY,collector_id uuid NOT NULL REFERENCES hamdee_private.ops_collectors(id),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 reconciled_date date NOT NULL,calculated_balance numeric NOT NULL,counted_balance numeric NOT NULL CHECK(counted_balance>=0 AND counted_balance<1000000000000000000 AND scale(counted_balance)<=12),
 difference numeric NOT NULL,opening_confirmed boolean NOT NULL,explanation varchar(2000) NOT NULL CHECK(length(trim(explanation))>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(difference=counted_balance-calculated_balance)
);
CREATE INDEX collector_count_date ON hamdee_private.collector_reconciliations(collector_id,currency,reconciled_date);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['collector_openings','collector_reconciliations'] LOOP
 EXECUTE format('ALTER TABLE hamdee_private.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hamdee_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON hamdee_private.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT,INSERT ON hamdee_private.%I TO hamdee_runtime',t);
 EXECUTE format('CREATE POLICY owner_read ON hamdee_private.%I FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner())',t);
 EXECUTE format('CREATE POLICY owner_insert ON hamdee_private.%I FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner())',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.%I FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only()',t);
 END LOOP;
END $$;
CREATE FUNCTION hamdee_private.check_collector_count() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF NEW.calculated_balance<>(SELECT coalesce(sum(delta),0) FROM hamdee_private.ops_money WHERE collector_id=NEW.collector_id AND currency=NEW.currency AND business_date<=NEW.reconciled_date)
 OR NEW.opening_confirmed<>EXISTS(SELECT 1 FROM hamdee_private.collector_openings WHERE collector_id=NEW.collector_id AND currency=NEW.currency AND opening_date<=NEW.reconciled_date)
 THEN RAISE EXCEPTION 'exact recorded collector comparison required';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collector_count_evidence BEFORE INSERT ON hamdee_private.collector_reconciliations FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_collector_count();
CREATE FUNCTION hamdee_private.check_collector_opening() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hamdee-operations-money',0));
 IF EXISTS(SELECT 1 FROM hamdee_private.ops_money WHERE collector_id=NEW.collector_id AND currency=NEW.currency AND business_date<NEW.opening_date)
 OR NOT EXISTS(SELECT 1 FROM hamdee_private.ops_money WHERE id=NEW.money_entry_id AND collector_id=NEW.collector_id AND currency=NEW.currency AND delta=NEW.opening_amount AND business_date=NEW.opening_date AND method=NEW.method AND entry_kind='opening' AND event_id=NEW.event_id)
 THEN RAISE EXCEPTION 'confirmed dated collector opening evidence required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_opening_evidence AFTER INSERT ON hamdee_private.collector_openings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_collector_opening();
DO $$ DECLARE definition text;marker text;BEGIN
 SELECT pg_get_functiondef('hamdee_private.guard_ops_money()'::regprocedure) INTO definition;
 marker:='IF NEW.entry_kind=''opening'' THEN';
 IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'review money opening guard before upgrade';END IF;
 EXECUTE replace(definition,marker,'IF NEW.entry_kind=''opening'' AND NEW.location_type=''collector'' THEN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.collector_openings x WHERE x.money_entry_id=NEW.id AND x.collector_id=NEW.collector_id AND x.currency=NEW.currency AND x.opening_amount=NEW.delta AND x.opening_date=NEW.business_date AND x.method=NEW.method AND x.event_id=NEW.event_id)
 THEN RAISE EXCEPTION ''explicit collector opening evidence required'';END IF;RETURN NEW;END IF; '||marker);
END $$;
CREATE FUNCTION hamdee_private.guard_collector_opening_date() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.collector_id IS NOT NULL AND EXISTS(SELECT 1 FROM hamdee_private.collector_openings WHERE collector_id=NEW.collector_id AND currency=NEW.currency AND opening_date>NEW.business_date)
 THEN RAISE EXCEPTION 'collector movement cannot precede confirmed opening';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collector_opening_date BEFORE INSERT ON hamdee_private.ops_money FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_collector_opening_date();
CREATE FUNCTION hamdee_private.check_cash_denominations() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE item jsonb;total numeric:=0;BEGIN
 IF NEW.count_details IS NULL THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.ops_accounts WHERE id=NEW.account_id AND kind='cash') OR jsonb_array_length(NEW.count_details)>20 THEN RAISE EXCEPTION 'denominations are physical cash counts only';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.count_details) LOOP
 IF (item->>'denomination')::numeric<=0 OR (item->>'quantity')::numeric<0 OR (item->>'quantity')::numeric<>trunc((item->>'quantity')::numeric) THEN RAISE EXCEPTION 'valid count components required';END IF;
 total:=total+(item->>'denomination')::numeric*(item->>'quantity')::numeric;
 END LOOP;
 IF total<>NEW.counted_balance THEN RAISE EXCEPTION 'count components must equal actual cash count';END IF;RETURN NEW;
END $$;
CREATE TRIGGER account_count_components BEFORE INSERT ON hamdee_private.account_reconciliations FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_cash_denominations();
REVOKE ALL ON FUNCTION hamdee_private.check_collector_count(),hamdee_private.check_collector_opening(),hamdee_private.check_cash_denominations(),hamdee_private.guard_collector_opening_date() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_collector_count(),hamdee_private.check_collector_opening(),hamdee_private.check_cash_denominations(),hamdee_private.guard_collector_opening_date() TO hamdee_runtime;
