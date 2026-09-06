import { validate } from './core.js';

export const MAX_BODY_BYTES = 750000;
const fields = ['version','events','tasks','entries','settings','sleepLogs','sleepOverrides','routines','routineChecks','rewards','appliedUpdates'];
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','vary':'Cookie'};
const tag = (owner,revision) => '"'+encodeURIComponent(owner)+':'+revision+'"';
const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{...headers,...(data.owner&&Number.isSafeInteger(data.revision)?{etag:tag(data.owner,data.revision)}:{})}});
const clean = state => Object.fromEntries(fields.map(key=>[key,state[key]]));
const latest = (db, owner) => db.prepare('SELECT revision, state_json, updated_at FROM ritm_calendars WHERE owner_id = ?').bind(owner).first();
const envelope = (owner,row) => ({owner,revision:row?.revision||0,state:row?JSON.parse(row.state_json):null,updatedAt:row?.updated_at||null});

export async function syncApi(request, env, owner = null) {
  if (!owner) return json({error:'Открой персональную ссылку, чтобы синхронизировать записи.',code:'auth'},401);
  if (!['GET','PUT'].includes(request.method)) return json({error:'Метод не поддерживается.'},405);
  if (request.method === 'PUT') {
    const origin = request.headers.get('origin');
    if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({error:'Открой календарь по его постоянной ссылке.'},403);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')) return json({error:'Ожидается JSON.'},415);
  }
  if (!env.DB) return json({error:'Общее хранилище временно недоступно. Изменения оставлены на устройстве.'},503);
  try {
    const db=env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
    if (request.method === 'GET') {
      const row=await latest(db,owner);
      const etag=tag(owner,row?.revision||0);
      if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers:{...headers,etag}});
      return json(envelope(owner,row));
    }
    const reader=request.body?.getReader();
    if (!reader) return json({error:'Пустой запрос.'},400);
    let total=0; const chunks=[];
    for (;;) {
      const {done,value}=await reader.read(); if(done)break;
      total+=value.byteLength;
      if(total>MAX_BODY_BYTES){await reader.cancel();return json({error:'Объём записей превышает лимит синхронизации 750 КБ. Сохрани резервную копию.'},413)}
      chunks.push(value);
    }
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
    let body,state;
    try {
      body=JSON.parse(new TextDecoder().decode(bytes));
      if(body.account!==owner)return json({error:'Календарь изменился. Обнови страницу перед сохранением.',code:'auth'},401);
      if(!Number.isSafeInteger(body.revision)||body.revision<0||body.state?.version!==3)throw Error('Некорректная версия данных. Обнови страницу.');
      validate(body.state);state=clean(body.state);validate(state);
    } catch(error) {return json({error:error.message||'Проверь данные.'},400)}
    const data=JSON.stringify(state),now=new Date().toISOString();
    const row=body.revision===0
      ? await db.prepare('INSERT INTO ritm_calendars (owner_id, revision, state_json, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT (owner_id) DO NOTHING RETURNING revision, state_json, updated_at').bind(owner,data,now).first()
      : await db.prepare('UPDATE ritm_calendars SET previous_state_json = state_json, state_json = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND revision = ? RETURNING revision, state_json, updated_at').bind(data,now,owner,body.revision).first();
    if(!row)return json({...envelope(owner,await latest(db,owner)),code:'conflict',error:'Другой экран сохранил изменения раньше.'},409);
    return json(envelope(owner,row));
  } catch {
    return json({error:'Не удалось подтвердить сохранение в календаре. Повтори синхронизацию.'},503);
  }
}
