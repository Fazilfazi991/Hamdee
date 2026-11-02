-- Additive disposable-local migration. Never apply directly to hosted data.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'disposable local HAMDEE schema required'; END IF;
END $$;

CREATE TABLE hamdee_private.expense_funding_links(
 payment_id uuid PRIMARY KEY REFERENCES hamdee_private.expense_payments(id) ON DELETE RESTRICT,
 entry_id uuid NOT NULL UNIQUE REFERENCES hamdee_private.ops_money(id) ON DELETE RESTRICT,
 event_id uuid NOT NULL REFERENCES hamdee_private.ops_events(id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hamdee_private.expense_funding_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hamdee_private.expense_funding_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hamdee_private.expense_funding_links FROM PUBLIC;
GRANT SELECT,INSERT ON hamdee_private.expense_funding_links TO hamdee_runtime;
CREATE POLICY funding_owner_read ON hamdee_private.expense_funding_links FOR SELECT TO hamdee_runtime USING(hamdee_private.rental_owner());
CREATE POLICY funding_owner_insert ON hamdee_private.expense_funding_links FOR INSERT TO hamdee_runtime WITH CHECK(hamdee_private.rental_owner());
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hamdee_private.expense_funding_links FOR EACH ROW EXECUTE FUNCTION hamdee_private.append_only();

-- Preserve every existing finance guard, relaxing only the account-only
-- expense restriction. Collector expenses require an actual linked bill payment.
DO $$ DECLARE definition text;before_text text;after_text text; BEGIN
 SELECT pg_get_functiondef('hamdee_private.guard_ops_money()'::regprocedure) INTO definition;
 before_text := 'IF NEW.location_type<>''account'' OR NEW.claim_id IS NOT NULL OR NEW.collection_id IS NOT NULL OR NEW.transfer_id IS NOT NULL THEN RAISE EXCEPTION ''explicit account expense required'';END IF;';
 after_text := 'IF NEW.claim_id IS NOT NULL OR NEW.collection_id IS NOT NULL OR NEW.transfer_id IS NOT NULL THEN RAISE EXCEPTION ''explicit funded expense required'';END IF;';
 IF position(before_text IN definition)=0 THEN RAISE EXCEPTION 'review expected money guard before migration';END IF;
 EXECUTE replace(definition,before_text,after_text);
END $$;

CREATE FUNCTION hamdee_private.check_expense_funding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p hamdee_private.expense_payments;e hamdee_private.property_expenses;m hamdee_private.ops_money; BEGIN
 SELECT * INTO p FROM hamdee_private.expense_payments WHERE id=NEW.payment_id;
 SELECT * INTO e FROM hamdee_private.property_expenses WHERE id=p.expense_id;
 SELECT * INTO m FROM hamdee_private.ops_money WHERE id=NEW.entry_id;
 IF p.status<>'recorded' OR m.entry_kind<>'expense' OR m.delta<>-p.amount_minor::numeric/100 OR m.currency<>e.currency OR m.business_date<>p.payment_date OR m.method<>p.method OR m.event_id<>NEW.event_id OR p.event_id<>NEW.event_id
 THEN RAISE EXCEPTION 'exact linked expense funding required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_funding_evidence AFTER INSERT ON hamdee_private.expense_funding_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_expense_funding();
CREATE FUNCTION hamdee_private.check_collector_expense_funding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.entry_kind='expense' AND NEW.location_type='collector' AND NOT EXISTS(SELECT 1 FROM hamdee_private.expense_funding_links WHERE entry_id=NEW.id)
 THEN RAISE EXCEPTION 'collector spending requires linked expense payment';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_expense_evidence AFTER INSERT ON hamdee_private.ops_money DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hamdee_private.check_collector_expense_funding();
CREATE FUNCTION hamdee_private.guard_funded_expense_correction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM hamdee_private.expense_funding_links WHERE entry_id=NEW.reversal_of)
 THEN RAISE EXCEPTION 'linked bill payment requires a coordinated expense correction';END IF;RETURN NEW;
END $$;
CREATE TRIGGER funded_expense_correction BEFORE INSERT ON hamdee_private.ops_money FOR EACH ROW EXECUTE FUNCTION hamdee_private.guard_funded_expense_correction();
REVOKE ALL ON FUNCTION hamdee_private.check_expense_funding(),hamdee_private.check_collector_expense_funding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.check_expense_funding(),hamdee_private.check_collector_expense_funding() TO hamdee_runtime;
REVOKE ALL ON FUNCTION hamdee_private.guard_funded_expense_correction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hamdee_private.guard_funded_expense_correction() TO hamdee_runtime;
