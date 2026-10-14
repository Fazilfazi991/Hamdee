import js from '@eslint/js';
import ts from 'typescript-eslint';
export default [
  { ignores: ['.next/**', 'node_modules/**', 'public/shared/**', 'tests/financial/reference/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['public/workspace/*.js'], languageOptions: { globals: Object.fromEntries(['window','document','fetch','crypto','URLSearchParams','FormData','console'].map(k=>[k,'readonly'])) } },
  { files: ['tests/**/*.cjs','tests/support/*.mjs'],
    languageOptions: { globals: Object.fromEntries(['require','module','__dirname','process','Buffer','console','structuredClone','URL'].map(k=>[k,'readonly'])) },
    rules: { '@typescript-eslint/no-require-imports':'off' } }
];
