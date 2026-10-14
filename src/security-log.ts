// Fixed event fields only: no tokens, identities, URLs, SQL, bodies or exception messages.
export interface SecurityEvent {
  event:'authentication_rejected'|'authorization_rejected'|'operation_unavailable'|'database_connection_error';
  requestId?:string;
  status:number;
}
export type SecurityLogger=(event:SecurityEvent)=>void;
export const securityLogger:SecurityLogger=event=>{console.warn(JSON.stringify(event));};
export function logSafely(logger:SecurityLogger,event:SecurityEvent){try{logger(event);}catch{/* Logging never changes a transaction outcome. */}}
