import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('.',import.meta.url));
export default { serverExternalPackages: ['pg'], experimental: { cpus: 1 }, poweredByHeader: false,
  turbopack:{root:directory},outputFileTracingRoot:directory,
  // Apply at the static-file layer too: rewritten public HTML must never
  // replace the authenticated proxy's no-store policy with public caching.
  async headers(){return ['/login','/login.html','/workspace','/workspace/index.html'].map(source=>({source,
    headers:[{key:'Cache-Control',value:'private, no-store, max-age=0'},{key:'Vary',value:'Cookie'}]}));},
  async rewrites(){return [{source:'/demo-assets/inter-latin.woff2',destination:'/shared/inter-latin.woff2'}];} };
