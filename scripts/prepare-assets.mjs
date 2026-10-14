// Shared HAMDEE assets are source files in this standalone repository.
// Verification never copies from another checkout or downloads anything.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const assets=JSON.parse(await readFile(new URL('scripts/shared-assets.json',root),'utf8'));
assert.equal(Object.keys(assets).length,5);
for(const [file,expected] of Object.entries(assets)){
  assert.ok(file.startsWith('public/shared/')&&!file.includes('..'));
  const actual=createHash('sha256').update(await readFile(new URL(file,root))).digest('hex').toUpperCase();
  assert.equal(actual,expected,'Shared asset differs: '+file);
}
console.log('Verified all 5 repository-local HAMDEE assets, including Inter OFL.');
