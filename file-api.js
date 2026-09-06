export const MAX_PDF_BYTES=10*1024*1024;
const CHUNK=512*1024;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'content-type':'application/json'}});
export async function fileApi(request,env,id){
 if(!/^[a-f0-9]{64}$/.test(id))return json({error:'Файл не найден.'},404);
 const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
 try{
  if(['GET','HEAD'].includes(request.method)){
   const meta=await db.prepare('SELECT size FROM ritm_files WHERE id = ?').bind(id).first();
   if(!meta)return json({error:'PDF отсутствует. Прикрепи файл к книге заново.'},404);
   let body=null;if(request.method==='GET'){
    const result=await db.prepare('SELECT data FROM ritm_file_chunks WHERE file_id = ? ORDER BY position').bind(id).all();
    const bytes=new Uint8Array(meta.size);let offset=0;
    for(const row of result.results){const chunk=new Uint8Array(row.data);bytes.set(chunk,offset);offset+=chunk.length}
    if(offset!==meta.size)throw Error('Incomplete file');body=bytes;
   }
   return new Response(body,{headers:{...headers,'content-type':'application/pdf','content-length':String(meta.size),'content-disposition':'attachment; filename="book.pdf"'}});
  }
  if(request.method!=='PUT')return json({error:'Метод не поддерживается.'},405);
  if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Открой свою персональную ссылку.'},403);
  if(!/^application\/pdf(?:;|$)/i.test(request.headers.get('content-type')||''))return json({error:'Выбери файл PDF.'},415);
  const reader=request.body?.getReader();if(!reader)return json({error:'Файл пустой.'},400);
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_PDF_BYTES){await reader.cancel();return json({error:'Максимальный размер PDF — 10 МБ.'},413)}chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return json({error:'Файл не похож на PDF.'},400);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(hash!==id)return json({error:'Файл передан не полностью. Выбери его ещё раз.'},400);
  const writes=[db.prepare('INSERT OR IGNORE INTO ritm_files (id,size,created_at) VALUES (?,?,?)').bind(id,size,new Date().toISOString())];
  for(let i=0;i<size;i+=CHUNK)writes.push(db.prepare('INSERT OR IGNORE INTO ritm_file_chunks (file_id,position,data) VALUES (?,?,?)').bind(id,i/CHUNK,bytes.slice(i,i+CHUNK).buffer));
  await db.batch(writes);
  return json({id,size});
 }catch(error){return json({error:String(error.message).includes('RITM_FILE_QUOTA')?'Библиотека PDF занимает 100 МБ. Сохрани файлы отдельно или увеличь хранилище.':'Не удалось сохранить или открыть PDF. Повтори попытку.'},503)}
}
