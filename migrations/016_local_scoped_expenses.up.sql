-- Additive disposable-local schema only. No hosted or production execution authority.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test')
 OR to_regclass('hamdee_private.expense_funding_links') IS NULL THEN RAISE EXCEPTION 'local connected expense schema required';END IF;
END $$;
ALTER TABLE hamdee_private.property_expenses ADD COLUMN scope text NOT NULL DEFAULT 'property'
 CHECK(scope IN ('property','company','personal'));
ALTER TABLE hamdee_private.property_expenses ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE hamdee_private.expense_events ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE hamdee_private.expense_payments ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE hamdee_private.property_expenses ADD CONSTRAINT scoped_expense_relationship
 CHECK((scope='property' AND property_id IS NOT NULL) OR (scope IN ('company','personal') AND property_id IS NULL AND room_id IS NULL AND maintenance_job_id IS NULL));
ALTER TABLE hamdee_private.property_expenses DROP CONSTRAINT property_expenses_category_check;
ALTER TABLE hamdee_private.property_expenses ADD CONSTRAINT property_expenses_category_check
 CHECK(category IN ('landlord','kahramaa','wifi_utilities','maintenance','cleaning','miscellaneous','service_charge','company_overhead'));
ALTER TABLE hamdee_private.expense_payments ADD CONSTRAINT scoped_payment_expense
 FOREIGN KEY(expense_id) REFERENCES hamdee_private.property_expenses(id);
CREATE UNIQUE INDEX scoped_expense_invoice ON hamdee_private.property_expenses(scope,lower(trim(vendor_name)),upper(trim(reference)))
 WHERE property_id IS NULL AND length(trim(reference))>0;
CREATE INDEX expense_scope_date ON hamdee_private.property_expenses(scope,expense_date,currency);
CREATE OR REPLACE FUNCTION hamdee_private.guard_expense_payment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE cost bigint;paid numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('expense-payment:'||NEW.expense_id::text,0));
 SELECT amount_minor INTO cost FROM hamdee_private.property_expenses WHERE id=NEW.expense_id AND property_id IS NOT DISTINCT FROM NEW.property_id;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM hamdee_private.expense_payments WHERE expense_id=NEW.expense_id AND status='recorded';
 IF cost IS NULL OR NEW.amount_minor+paid>cost THEN RAISE EXCEPTION 'payment exceeds unpaid expense';END IF;
 RETURN NEW;
END $$;
