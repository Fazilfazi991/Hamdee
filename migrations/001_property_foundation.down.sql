-- DESTRUCTIVE LOCAL-TEST RESET ONLY. Never run against hosted/live data.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM hamdee_private.application_identity WHERE app_id='hamdee' AND environment='local-test') THEN
  RAISE EXCEPTION 'not an isolated HAMDEE local-test schema';
 END IF;
END $$;
DROP SCHEMA hamdee_private CASCADE;
