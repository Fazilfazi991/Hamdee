import { SupabaseIdentityProvider,type SupabaseUserClient } from './auth';
import { validateDevelopmentConfig,type ReviewedDevelopmentPins } from './development-config';
import { requireThat } from './errors';

// Server-internal factory for later integration. Not imported by deployable
// routes. SDK construction/real sessions still require separate approval/tests.
export function prepareDevelopmentIdentityAdapter(values:Readonly<Record<string,string|undefined>>,pins:ReviewedDevelopmentPins,binding:{client:SupabaseUserClient;projectUrl:string}) {
  const config=validateDevelopmentConfig(values,pins);
  requireThat(binding.projectUrl===config.supabaseUrl,503,'CONFIGURATION_UNAVAILABLE','The dedicated HAMDEE identity client is unavailable.');
  return new SupabaseIdentityProvider(binding.client,config.issuer);
}
