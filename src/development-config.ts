import { ApiError } from './errors';

// Pure offline preparation. Never reads process.env, constructs an SDK client,
// opens a connection or activates the normal Next route.
export interface ReviewedDevelopmentPins {
  projectRef:string;
  ownerIdentifier:string|null;
  region:string|null;
  residencyDecision:string|null;
  integrationApproval:string|null;
  databaseHost:string|null;
  databasePort:number|null;
  databaseName:string|null;
  databaseUser:string|null;
  sessionTransport:'bearer'|'server_cookie'|null;
}
export interface PreparedDevelopmentConfig {
  readonly appId:'hamdee';readonly environment:'development';readonly projectRef:string;
  readonly supabaseUrl:string;readonly issuer:string;readonly audience:'authenticated';
  readonly ownerIdentifier:string;readonly region:string;readonly residencyDecision:string;
  readonly sessionTransport:'bearer'|'server_cookie';
  readonly database:Readonly<{host:string;port:number;name:string;user:string;tls:'verify-full'}>;
}
const unavailable=()=>new ApiError(503,'CONFIGURATION_UNAVAILABLE','Dedicated HAMDEE development configuration is incomplete or mismatched. Review the approved environment checklist.');
const present=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
function check(value:unknown):asserts value {if(!value)throw unavailable();}

export function validateDevelopmentConfig(values:Readonly<Record<string,string|undefined>>,pins:ReviewedDevelopmentPins):PreparedDevelopmentConfig {
  try{
    check(/^[a-z]{20}$/.test(pins.projectRef));
    check([pins.ownerIdentifier,pins.region,pins.residencyDecision,pins.integrationApproval,pins.databaseHost,pins.databaseName,pins.databaseUser].every(present));
    check(Number.isInteger(pins.databasePort)&&pins.databasePort!>0&&pins.databasePort!<=65535);
    check(pins.sessionTransport==='bearer'||pins.sessionTransport==='server_cookie');
    check(!Object.keys(values).some(key=>/^HAMDEE_(TEST_AUTH|AUTH_BYPASS)/.test(key)||/^NEXT_PUBLIC_.*(DATABASE|SESSION_SECRET|ADMIN_KEY|SERVICE_ROLE)/.test(key)));
    check(values.HAMDEE_APP_ID==='hamdee'&&values.HAMDEE_ENVIRONMENT==='development');
    check(values.HAMDEE_PROJECT_OWNER===pins.ownerIdentifier&&values.HAMDEE_REGION===pins.region&&values.HAMDEE_RESIDENCY_DECISION===pins.residencyDecision);
    const origin='https://'+pins.projectRef+'.supabase.co',url=new URL(values.HAMDEE_SUPABASE_URL||'');
    check(url.origin===origin&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password);
    check(values.HAMDEE_AUTH_ISSUER===origin+'/auth/v1'&&values.HAMDEE_AUTH_AUDIENCE==='authenticated');
    check(/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(values.HAMDEE_SUPABASE_PUBLISHABLE_KEY||''));
    // Administrative keys belong to a separate invitation job, never this config.
    check(!values.HAMDEE_SUPABASE_ADMIN_KEY);
    const db=new URL(values.HAMDEE_DATABASE_URL||'');
    check(['postgres:','postgresql:'].includes(db.protocol)&&db.hostname===pins.databaseHost&&Number(db.port)===pins.databasePort&&db.pathname==='/'+pins.databaseName);
    check(decodeURIComponent(db.username)===pins.databaseUser&&present(db.password)&&!db.search&&!db.hash);
    check(values.HAMDEE_DATABASE_TLS==='verify-full'&&values.HAMDEE_SESSION_TRANSPORT===pins.sessionTransport);
    if(pins.sessionTransport==='server_cookie')check((values.HAMDEE_SESSION_SECRET||'').length>=32);
    // Credentials are intentionally absent from the prepared metadata result.
    return Object.freeze({appId:'hamdee',environment:'development',projectRef:pins.projectRef,supabaseUrl:origin,issuer:origin+'/auth/v1',audience:'authenticated',
      ownerIdentifier:pins.ownerIdentifier!,region:pins.region!,residencyDecision:pins.residencyDecision!,sessionTransport:pins.sessionTransport,
      database:Object.freeze({host:pins.databaseHost!,port:pins.databasePort!,name:pins.databaseName!,user:pins.databaseUser!,tls:'verify-full'})});
  }catch{throw unavailable();}
}
