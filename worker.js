import {syncApi} from './sync-api.js';
const encoder=new TextEncoder();
const security={
  'cache-control':'private, no-store',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'x-frame-options':'DENY',
  'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'strict-transport-security':'max-age=31536000',
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...security,'content-type':'application/json; charset=utf-8'}});
const page=(body,status=200)=>new Response(body,{status,headers:{...security,'content-type':'text/html; charset=utf-8'}});
const validKey=key=>typeof key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(key);
async function keyMatches(candidate,expected) {
  if(!validKey(candidate)||!validKey(expected))return false;
  const algorithm={name:'HMAC',hash:'SHA-256'};
  const key=await crypto.subtle.importKey('raw',encoder.encode(expected),algorithm,false,['sign','verify']);
  const comparison=await crypto.subtle.importKey('raw',encoder.encode(candidate),algorithm,false,['sign']);
  const challenge=encoder.encode('ritm-link-access-v1');
  return crypto.subtle.verify('HMAC',key,await crypto.subtle.sign('HMAC',comparison,challenge),challenge);
}
const intro=message=>`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Ритм</title><style>:root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color-scheme:light dark;background:light-dark(#f5f5f7,#111113);color:light-dark(#1c1c1e,#f5f5f7)}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;box-sizing:border-box}main{max-width:360px;background:light-dark(#fff,#1e1e21);padding:32px;border-radius:28px}h1{font-size:36px;letter-spacing:-1px;margin:0 0 16px}p{line-height:1.6;margin:0;color:light-dark(#62626a,#a8a8b2)}</style></head><body><main><h1>Твой ритм.</h1><p>${message}</p></main></body></html>`;
export async function handleRequest(request,env,html) {
  const url=new URL(request.url);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))return json({error:'Открой защищённую ссылку HTTPS.'},403);
  if(url.pathname==='/health')return json({ok:true,configured:validKey(env.CALENDAR_KEY)&&!!env.DB});
  const match=url.pathname.match(/^\/c\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/);
  if(!match||!await keyMatches(match[1],env.CALENDAR_KEY))return page(intro('Открой свою персональную ссылку. Она сразу откроет календарь на любом твоём устройстве.'),404);
  const base=`${url.origin}/c/${match[1]}/`,path=match[2]||'';
  if(!env.DB)return json({error:'Общее хранилище календаря ещё настраивается.'},503);
  try {
    if(path==='api/state') {
      const response=await syncApi(request,env,'calendar-owner');
      for(const [key,value]of Object.entries(security))response.headers.set(key,value);
      return response;
    }
    if(!['','index.html','ritm-calendar.html'].includes(path))return json({error:'Страница не найдена.'},404);
    if(!['GET','HEAD'].includes(request.method))return json({error:'Метод не поддерживается.'},405);
    if(!url.pathname.endsWith('/')&&!path)return new Response(null,{status:308,headers:{...security,location:base}});
    return page(request.method==='HEAD'?null:html.replaceAll('__RITM_ORIGIN__',base));
  } catch {
    return json({error:'Сервер временно недоступен. Изменения не подтверждены. Повтори попытку.'},503);
  }
}
