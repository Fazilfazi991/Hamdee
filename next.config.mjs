import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('.',import.meta.url));
export default { serverExternalPackages: ['pg'], experimental: { cpus: 1 }, poweredByHeader: false,
  turbopack:{root:directory},outputFileTracingRoot:directory,
  async rewrites(){return [{source:'/demo-assets/inter-latin.woff2',destination:'/shared/inter-latin.woff2'}];} };
