import { ApiError } from './errors';
import { uuid } from './validation';
export interface Identity { issuer: string; subject: string }
export interface IdentityProvider { readonly kind?: string; validate(request: Request): Promise<Identity> }
// Optional server-internal, request-scoped revalidation. It cannot be supplied
// by JSON/JWT/client claims and adds no browser field or persistent session store.
const identityChecks=new WeakMap<Identity,()=>Promise<void>>();
export function bindIdentityRecheck(identity:Identity,check:()=>Promise<void>):Identity {
  const bound=Object.freeze({issuer:identity.issuer,subject:identity.subject});identityChecks.set(bound,check);return bound;
}
export async function recheckIdentity(identity:Identity):Promise<void> {await identityChecks.get(identity)?.();}

// Structural SDK contract: an approved server-side Supabase client can implement it.
// No service_role key, browser role, decoded-only JWT or getSession is trusted.
export interface SupabaseUserClient {
  auth: { getUser(jwt: string): Promise<{ data: { user: { id: string;is_anonymous?:boolean } | null }; error: unknown }> };
}
export class SupabaseIdentityProvider implements IdentityProvider {
  readonly kind='supabase-server-validated';
  constructor(private client: SupabaseUserClient, private issuer: string) {
    const url=new URL(issuer);
    if(url.protocol!=='https:'||url.pathname!=='/auth/v1'||url.search||url.hash||url.username||url.password)
      throw new Error('An explicitly approved HAMDEE identity issuer is required.');
  }
  async validate(request: Request): Promise<Identity> {
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in with an authorized account.');
    try {
      const { data, error } = await this.client.auth.getUser(token);
      if (error || !data.user || !uuid.test(data.user.id) || data.user.is_anonymous) throw new Error('invalid');
      return { issuer: this.issuer, subject: data.user.id };
    } catch {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in with an authorized account.');
    }
  }
}
