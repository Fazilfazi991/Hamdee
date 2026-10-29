// Private owner documents: no shared links, local storage or public bucket.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const maxBytes=1024*1024;
const allowed=new Set(['application/pdf','image/jpeg','image/png']);
let current=null;
const live=c=>current===c&&!c.signal.aborted&&c.isCurrent();
export function resetDocuments(){if(current)current=null;}
function table(c){
 const rows=c.items.map(item=>`<tr><td><a href="/api/hamdee/v1/documents/${encodeURIComponent(item.id)}">${esc(item.name)}</a></td><td>${esc(item.roomId?c.rooms.find(r=>r.id===item.roomId)?.code||'Room':'Entire villa')}</td><td>${Math.ceil(item.size/1024)} KB</td></tr>`).join('');
 c.target.querySelector('[data-doc-list]').innerHTML=rows?`<div class="table-wrap" role="region" aria-label="Saved documents" tabindex="0"><table class="data-table"><thead><tr><th>Document</th><th>Location</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted-help">No documents saved yet.</p>';
 const more=c.target.querySelector('[data-doc-more]');more.hidden=!c.cursor;more.style.display=c.cursor?'':'none';
}
async function load(c,more=false){
 const filters={propertyId:c.property.id,...(more&&c.cursor?{cursor:c.cursor}:{})};
 const result=await c.api.documentRead(filters,c.signal);if(!live(c))return;
 if(!await c.verifyAccess()||!live(c))return;
 const data=result?.data;if(!data||!Array.isArray(data.items)||!(data.nextCursor===null||typeof data.nextCursor==='string')||!data.items.every(item=>typeof item.id==='string'&&typeof item.name==='string'&&Number.isSafeInteger(item.size)&&item.size>0&&item.size<=maxBytes))throw new Error('Documents could not be loaded.');
 const seen=new Set(c.items.map(item=>item.id));if(!more){c.items=[];seen.clear();}
 for(const item of data.items)if(!seen.has(item.id)){seen.add(item.id);c.items.push(item);}
 c.cursor=data.nextCursor;table(c);
}
function displayError(c,error){
 if(!live(c))return;
 if(error?.status===401||error?.code==='OWNER_ACCESS_DENIED'){c.target.innerHTML='';void c.onAccessLoss(error);return;}
 c.target.querySelector('[data-doc-error]').textContent=error?.message||'The document operation could not be completed.';
}
async function base64(file){
 const bytes=new Uint8Array(await file.arrayBuffer());let value='';
 for(let start=0;start<bytes.length;start+=8192)value+=String.fromCharCode(...bytes.subarray(start,start+8192));
 return window.btoa(value);
}
export async function renderDocuments(target,options){
 resetDocuments();const c={...options,target,items:[],cursor:null,rooms:options.rooms||[],pending:null};current=c;
 if(!live(c))return;
 target.innerHTML=`<section class="panel rental-panel"><div class="panel-header"><div><h2>Documents</h2><p>Optional private villa and room documents.</p></div></div><div class="panel-body"><form data-doc-form class="form-grid rental-form-grid"><div class="field"><label for="doc-room">Room</label><select id="doc-room" name="roomId"><option value="">Entire villa</option>${c.rooms.map(r=>`<option value="${esc(r.id)}">${esc(r.code)}</option>`).join('')}</select></div><div class="field"><label for="doc-file">Choose document</label><input id="doc-file" name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required><small>PDF, JPG or PNG · maximum 1 MB</small></div><button type="submit" class="button primary" data-doc-save>Save document</button></form><p data-doc-status role="status"></p><p data-doc-error role="alert"></p><div data-doc-list></div><button type="button" class="button subtle" data-doc-more style="display:none" hidden>Load more documents</button></div></section>`;
 const form=target.querySelector('[data-doc-form]'),save=target.querySelector('[data-doc-save]'),fileInput=target.querySelector('[name="file"]'),roomInput=target.querySelector('[name="roomId"]');
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(!live(c)||save.disabled)return;const error=target.querySelector('[data-doc-error]'),status=target.querySelector('[data-doc-status]');error.textContent='';status.textContent='';save.disabled=true;
  try{
   if(!c.pending){const file=fileInput.files?.[0];if(!file||file.size<1||file.size>maxBytes||!allowed.has(file.type))throw new Error('Choose a PDF, JPG or PNG file no larger than 1 MB.');
    const payload={propertyId:c.property.id,roomId:roomInput.value||null,name:file.name,mimeType:file.type,base64:await base64(file)};if(!live(c))return;c.pending={key:crypto.randomUUID(),payload};}
   fileInput.disabled=true;roomInput.disabled=true;
   await c.api.documentWrite(c.pending.payload,c.pending.key,c.signal);if(!live(c))return;if(!await c.verifyAccess()||!live(c))return;
   c.pending=null;fileInput.disabled=false;roomInput.disabled=false;form.reset();save.textContent='Save document';status.textContent='Document saved.';
   try{await load(c);}catch(loadError){if(live(c)){error.textContent='Document saved, but the list could not be refreshed. Reload this view.';}if(loadError?.status===401||loadError?.code==='OWNER_ACCESS_DENIED')displayError(c,loadError);}
  }catch(errorValue){if(!live(c))return;if(errorValue?.status&&errorValue.status<500&&!errorValue.uncertain){c.pending=null;fileInput.disabled=false;roomInput.disabled=false;save.textContent='Save document';}else if(c.pending){save.textContent='Retry same upload';status.textContent='The result could not be confirmed. Retry the same upload.';}displayError(c,errorValue);}
  finally{if(live(c))save.disabled=false;}
 });
 target.querySelector('[data-doc-more]').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await load(c,true);}catch(error){displayError(c,error);}finally{if(live(c))event.currentTarget.disabled=false;}});
 try{await load(c);}catch(error){displayError(c,error);}
}
