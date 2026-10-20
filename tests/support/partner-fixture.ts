import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture, adapter, issuer } from './fixture';
import { PartnerService } from '../../src/partners';
import { PropertyService } from '../../src/service';
export const partnerMigration = () => readFile(new URL('../../migrations/008_local_partner_records.up.sql', import.meta.url), 'utf8');
export async function partnerFixture(persistent = false) {
  const f = await fixture(persistent);
  await f.pg.transaction(async tx => { await tx.exec(await partnerMigration());await tx.exec(await readFile(new URL('../../migrations/009_local_partner_corrections.up.sql',import.meta.url),'utf8')); });
  const identity = { issuer, subject: f.users.admin.subject };
  const ownerProperties = new PropertyService(adapter(f.pg), identity);
  const partners = new PartnerService(ownerProperties);
  const write = (body: unknown, key: string = randomUUID()) => partners.mutate(identity, body, key, randomUUID());
  const contact = async (name = 'Synthetic investor') => (await write({ action: 'create-partner', name })).data;
  const link = (propertyId: unknown, partnerId: unknown) => write({ action: 'link-property', propertyId, partnerId });
  const entry = (propertyId: unknown, partnerId: unknown, fields: Record<string, unknown> = {}) => write({ action: 'record-entry', propertyId, partnerId,
    kind: 'contribution', entryDate: '2026-10-05', amount: '12.34', currency: 'XTS', reference: 'SYNTHETIC', ...fields });
  return { ...f, identity, ownerProperties, partners, write, contact, link, entry };
}
