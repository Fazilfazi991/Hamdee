import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const source = (file: string) => readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8');
const hash = (value: string) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const tables = ['car_vehicles', 'car_vehicle_revisions', 'car_agreements', 'car_receipts', 'car_expenses'];

test('Independent proposed007 review: exact pinned local body, whole transaction, five invoker functions and no role/credential creation', async () => {
  const wrapper = await source('hosted/car_rental_synthetic_development.sql'), local = await source('007_local_car_rentals.up.sql');
  assert.equal(hash(wrapper), '5aeb6bb0aec6387df0aa282fda57b5a46b6f6a8f9c57098bc461c8f9786bec84');
  assert.equal(hash(local), '9baa4297ceffab72b45265ad7baadd799e3512e7d67049054914d2a63df07f59');
  const parts = wrapper.split('$reviewed_007$'); assert.equal(parts.length, 3); assert.equal(hash(parts[1]), hash(local));
  assert.deepEqual([...local.matchAll(/CREATE TABLE hamdee_private\.(car_[a-z_]+)/g)].map(match => match[1]), tables);
  assert.equal([...local.matchAll(/SECURITY INVOKER SET search_path=pg_catalog/g)].length, 5);
  assert.doesNotMatch(wrapper, /\b(?:CREATE|ALTER)\s+ROLE\b|\bSECURITY\s+DEFINER\b|\bPASSWORD\s+'/i);
  assert.match(wrapper, /\nBEGIN;/); assert.match(wrapper.trim(), /COMMIT;$/);
  assert.match(parts[2], /project_ref='dytlzfwbgeuhzgzemqsf'/); assert.match(parts[2], /data_class='synthetic_only'/);
});

test('Independent disposable wrapper model: unexpected provider column privilege fails closed and creates no car objects or changed role state', async () => {
  // This is an in-process synthetic model, never the connected hosted database.
  const pg = new PGlite();
  try {
    await pg.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    await pg.exec(await source('hosted/initial_synthetic_development.sql'));
    await pg.exec('ALTER ROLE hamdee_backend LOGIN'); await pg.exec(await source('hosted/operations_synthetic_development.sql'));
    await pg.exec('GRANT INSERT(name) ON hamdee_private.properties TO anon');
    const roles = 'SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles ORDER BY rolname';
    const beforeRoles = (await pg.query(roles)).rows;
    const beforeCatalog = (await pg.query("SELECT oid,relname,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace ORDER BY oid")).rows;
    await assert.rejects(pg.exec(await source('hosted/car_rental_synthetic_development.sql')), /unsafe required-table privileges\/RLS/);
    await pg.exec('ROLLBACK');
    assert.deepEqual((await pg.query(roles)).rows, beforeRoles);
    assert.deepEqual((await pg.query("SELECT oid,relname,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace ORDER BY oid")).rows, beforeCatalog);
    assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace AND left(relname,4)='car_'")).rows[0].n, 0);
    assert.equal((await pg.query<{ allowed: boolean }>("SELECT has_column_privilege('anon','hamdee_private.properties','name','INSERT') AS allowed")).rows[0].allowed, true);
  } finally { await pg.close(); }
});
