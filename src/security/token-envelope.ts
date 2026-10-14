import type { SecureRandomPort,TokenEnvelopePort } from './contracts';
import { validateBinding } from './contracts';
import { createCipheriv,createDecipheriv } from 'node:crypto';

export interface TokenEnvelopeOptions {
  /** Required server-held AES-256 keys, indexed by explicit rotation version. */
  readonly keys:Readonly<Record<string,Uint8Array>>;
  readonly activeKeyVersion:string;
  readonly random:SecureRandomPort;
}
export class TokenEnvelopeError extends Error {
  readonly code='TOKEN_ENVELOPE_INVALID';
  constructor(){super('HAMDEE token envelope is unavailable or invalid.');this.name='TokenEnvelopeError';}
}
/** Server-only authenticated encryption; no environment, SDK or network. */
export function createTokenEnvelope(options:TokenEnvelopeOptions):TokenEnvelopePort {
  const algorithm='aes-256-gcm-v1',versionPattern=/^[A-Za-z0-9_-]{1,64}$/;
  const invalid=():never=>{throw new TokenEnvelopeError();};
  const keys=new Map<string,Buffer>();
  let active:string,bytes:(length:number)=>Uint8Array;
  try{
    active=options.activeKeyVersion;
    if(!versionPattern.test(active)||!options.keys||typeof options.random?.bytes!=='function')invalid();
    for(const [version,key] of Object.entries(options.keys)){
      if(!versionPattern.test(version)||!(key instanceof Uint8Array)||key.byteLength!==32)invalid();
      keys.set(version,Buffer.from(key));
    }
    if(!keys.has(active))invalid();
    bytes=options.random.bytes.bind(options.random);
  }catch{invalid();}
  const usedNonces=new Set<string>();
  function aad(binding:Parameters<TokenEnvelopePort['seal']>[1],version:string):Buffer {
    validateBinding(binding);
    return Buffer.from(JSON.stringify(['hamdee/server-token-envelope/v1',algorithm,version,
      binding.provider,binding.appId,binding.environment,binding.dataClass,binding.projectRef,binding.issuer,binding.audience]));
  }
  function tokens(value:unknown){
    if(!value||typeof value!=='object'||Array.isArray(value))invalid();
    const v=value as Record<string,unknown>;
    if(Object.keys(v).length!==2||!['accessToken','refreshToken'].every(k=>Object.hasOwn(v,k)))invalid();
    for(const token of [v.accessToken,v.refreshToken])if(typeof token!=='string'||token.length<1||token.length>16384||!/^[\x21-\x7e]+$/.test(token))invalid();
    return Object.freeze({accessToken:v.accessToken as string,refreshToken:v.refreshToken as string});
  }
  function decode(value:string,min:number,max:number){
    if(typeof value!=='string'||value.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(value))invalid();
    const result=Buffer.from(value,'base64url');
    if(result.length<min||result.length>max||result.toString('base64url')!==value)invalid();
    return result;
  }
  return Object.freeze<TokenEnvelopePort>({
    async seal(value,binding){
      let plaintext:Buffer|undefined;
      try{
        plaintext=Buffer.from(JSON.stringify(tokens(value)));const associated=aad(binding,active);
        const nonceInput=bytes(12);
        if(!(nonceInput instanceof Uint8Array)||nonceInput.byteLength!==12)invalid();
        const nonce=Buffer.from(nonceInput),encoded=nonce.toString('base64url');
        if(usedNonces.has(encoded))invalid();
        // Never retry encryption with a reused nonce, including after failure.
        usedNonces.add(encoded);
        const cipher=createCipheriv('aes-256-gcm',keys.get(active)!,nonce,{authTagLength:16});
        cipher.setAAD(associated);
        const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
        return Object.freeze({keyVersion:active,algorithm,nonce:encoded,ciphertext:ciphertext.toString('base64url')});
      }catch{throw new TokenEnvelopeError();}
      finally{plaintext?.fill(0);}
    },
    async open(value,binding){
      let plaintext:Buffer|undefined;
      try{
        if(!value||Object.keys(value).length!==4||value.algorithm!==algorithm||!versionPattern.test(value.keyVersion)||!keys.has(value.keyVersion))invalid();
        const nonce=decode(value.nonce,12,12),ciphertext=decode(value.ciphertext,17,33064);
        const decipher=createDecipheriv('aes-256-gcm',keys.get(value.keyVersion)!,nonce,{authTagLength:16});
        decipher.setAAD(aad(binding,value.keyVersion));decipher.setAuthTag(ciphertext.subarray(-16));
        plaintext=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
        const decoded=plaintext.toString('utf8');
        if(!Buffer.from(decoded).equals(plaintext))invalid();
        return tokens(JSON.parse(decoded));
      }catch{throw new TokenEnvelopeError();}
      finally{plaintext?.fill(0);}
    }
  });
}
