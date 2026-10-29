import { createHash, randomUUID } from 'node:crypto';
import type { Identity } from './auth';
import { requireThat } from './errors';
import { PropertyService } from './service';
import { uuid } from './validation';

export const DOCUMENT_MAX_BYTES=1024*1024;
export const DOCUMENT_MAX_JSON_BYTES=1408000;
type Row=Record<string,unknown>;
const check=(ok:unknown,message:string,code='INVALID_DOCUMENT',status=422)=>requireThat(ok,status,code,message);
const id=(value:unknown):string=>{check(typeof value==='string'&&uuid.test(value),'Select a valid record.');return value as string;};
const metadata=(r:Row)=>({id:r.id,propertyId:r.property_id,roomId:r.room_id,name:r.name,mimeType:r.mime_type,
  size:Number(r.size),createdAt:r.created_at instanceof Date?r.created_at.toISOString():r.created_at});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const unsafeNameCharacter=(c:string)=>c.charCodeAt(0)<32||c.charCodeAt(0)===127||c==='/'||c==='\\';
const FILE_TYPES:Record<string,{ext:string;signature:number[]}>=Object.freeze({
  'application/pdf':{ext:'pdf',signature:[0x25,0x50,0x44,0x46,0x2d]},
  'image/jpeg':{ext:'jpg',signature:[0xff,0xd8,0xff]},
  'image/png':{ext:'png',signature:[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]}
});
export class DocumentService {
  constructor(private readonly properties:PropertyService){}
  async list(identity:Identity,property:unknown,room?:unknown,cursor?:unknown){
    const propertyId=id(property),roomId=room===undefined?null:id(room),after=cursor===undefined?null:id(cursor);
    return this.properties.ownerContext(identity,async sql=>{
      const result=await sql.query<Row>(`SELECT id,property_id,room_id,name,mime_type,octet_length(content) AS size,created_at
        FROM hamdee_private.property_documents WHERE property_id=$1 AND ($2::uuid IS NULL OR room_id=$2)
        AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 101`,[propertyId,roomId,after]);
      return {items:result.rows.slice(0,100).map(metadata),nextCursor:result.rows.length>100?result.rows[99].id:null};
    });
  }
  async get(identity:Identity,document:unknown){
    const documentId=id(document);
    return this.properties.ownerContext(identity,async sql=>{
      const row=(await sql.query<Row>('SELECT id,name,mime_type,content,content_sha256 FROM hamdee_private.property_documents WHERE id=$1',[documentId])).rows[0];
      check(row,'Document not found.','NOT_FOUND',404);
      check(row.content instanceof Uint8Array&&row.content.length<=DOCUMENT_MAX_BYTES&&hash(row.content)===row.content_sha256,'Document is unavailable.','DOCUMENT_UNAVAILABLE',503);
      return {name:String(row.name),mimeType:String(row.mime_type),content:Buffer.from(row.content as Uint8Array)};
    });
  }
  async upload(identity:Identity,input:unknown,key:unknown){
    const commandKey=id(key);check(input&&typeof input==='object'&&!Array.isArray(input),'Choose a document.');
    const body=input as Row;check(Object.keys(body).every(k=>['propertyId','roomId','name','mimeType','base64'].includes(k)),'Unknown document field.');
    const propertyId=id(body.propertyId),roomId=body.roomId==null||body.roomId===''?null:id(body.roomId);
    check(typeof body.name==='string'&&body.name.trim().length>0&&body.name.length<=200&&![...body.name].some(unsafeNameCharacter),'Enter a valid document name.');
    const name=(body.name as string).trim(),mimeType=String(body.mimeType),type=FILE_TYPES[mimeType];
    check(type,'Only PDF, JPEG and PNG documents are supported.');
    check(typeof body.base64==='string'&&body.base64.length<=Math.ceil(DOCUMENT_MAX_BYTES/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64),'Choose a valid file.');
    const content=Buffer.from(body.base64 as string,'base64');
    check(content.length>0&&content.length<=DOCUMENT_MAX_BYTES&&content.toString('base64')===body.base64,'File must be at most 1 MB.');
    check(type.signature.every((byte,index)=>content[index]===byte),'File contents do not match its type.');
    const contentHash=hash(content),digest=hash(JSON.stringify([propertyId,roomId,name,mimeType,contentHash]));
    return this.properties.ownerContext(identity,async(sql,actorId)=>{
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['document:'+actorId+':'+commandKey]);
      const existing=(await sql.query<Row>('SELECT id,property_id,room_id,name,mime_type,octet_length(content) AS size,created_at,command_digest FROM hamdee_private.property_documents WHERE actor_id=$1 AND command_key=$2',[actorId,commandKey])).rows[0];
      if(existing){check(existing.command_digest===digest,'Use a new upload key for a changed document.','IDEMPOTENCY_KEY_REUSED',409);return {data:metadata(existing),replay:true};}
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['property:'+propertyId]);
      const property=(await sql.query<Row>('SELECT id,lifecycle_status FROM hamdee_private.properties WHERE id=$1',[propertyId])).rows[0];
      check(property,'Property not found.','NOT_FOUND',404);check(property.lifecycle_status==='registered','Restore the property before uploading a document.','PROPERTY_ARCHIVED',409);
      if(roomId){const room=(await sql.query<Row>('SELECT id FROM hamdee_private.rooms WHERE id=$1 AND property_id=$2',[roomId,propertyId])).rows[0];check(room,'Choose a room in this property.','NOT_FOUND',404);}
      const result=(await sql.query<Row>(`INSERT INTO hamdee_private.property_documents(id,property_id,room_id,name,mime_type,content,content_sha256,actor_id,command_key,command_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,property_id,room_id,name,mime_type,octet_length(content) AS size,created_at`,
        [randomUUID(),propertyId,roomId,name,mimeType,content,contentHash,actorId,commandKey,digest])).rows[0];
      return {data:metadata(result),replay:false};
    });
  }
}
export function documentDisposition(name:string,mimeType:string){
  const ext=FILE_TYPES[mimeType]?.ext;check(ext,'Document is unavailable.','DOCUMENT_UNAVAILABLE',503);
  // Fixed ASCII fallback and RFC 5987 encoded name prevent response splitting.
  const safe=[...name].map(c=>unsafeNameCharacter(c)?'_':c).join('');
  return `attachment; filename="hamdee-document.${ext}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`;
}
