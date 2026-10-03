const CACHE_NAME='base-card-offline-v28';
const APP_SHELL=[
  './','./index.html','./styles.css?v=49','./app.js?v=161',
  './supabase-config.js','./km-game-catalog.js?v=4','./km-images.js?v=5','./my-payments.js?v=3',
  './account-security.js?v=6','./chatapps-fix-v6.js?v=28','./kmcard-ui.js?v=45',
  './transfer-fallback.js?v=9','./manifest.webmanifest'
];
const INDEX_URL=new URL('./index.html',self.registration.scope).href;
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('base-card-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
function adminNotificationUrl(candidate,tab){
  const fallback=new URL(`./admin.html?tab=${tab}`,self.registration.scope);
  try{
    const target=new URL(candidate||fallback.href,self.registration.scope);
    const scopePath=new URL(self.registration.scope).pathname;
    return target.origin===self.location.origin&&target.pathname.startsWith(scopePath)?target.href:fallback.href;
  }catch(_){return fallback.href}
}
self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?event.data.json():{}}catch(_){payload={body:event.data?.text?.()||''}}
  if(!payload||typeof payload!=='object')payload={body:String(payload)};
  const data=payload.data&&typeof payload.data==='object'?payload.data:{};
  const info=payload.notification&&typeof payload.notification==='object'?payload.notification:payload;
  const eventType=[payload.type,payload.event_type,payload.table,data.type,data.table].filter(Boolean).join(' ').toLowerCase();
  const tab=/top.?up|deposit|wallet/.test(eventType)?'topups':/support|message/.test(eventType)?'messages':'topups';
  const title=String(info.title||payload.title||data.title||'تنبيه من Base Card').slice(0,80);
  const body=String(info.body||info.message||payload.body||payload.message||data.body||data.message||'وصل طلب شحن أو رسالة دعم جديدة إلى الموقع.').slice(0,220);
  const url=adminNotificationUrl(info.url||payload.url||data.url,tab);
  const options={body,icon:new URL('./icon-192.png',self.registration.scope).href,badge:new URL('./icon-192.png',self.registration.scope).href,data:{url,eventType}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=adminNotificationUrl(event.notification.data?.url,'topups');
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>client.url.startsWith(self.registration.scope));
    if(existing){try{await existing.navigate(target);return await existing.focus()}catch(_){}}
    return self.clients.openWindow(target);
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4500);
    try{
      const response=await fetch(request,{signal:controller.signal});
      if(response.ok)await cache.put(request,response.clone());
      return response;
    }catch(_){
      return await cache.match(request)||(request.mode==='navigate'?await cache.match(INDEX_URL):Response.error());
    }finally{clearTimeout(timer)}
  })());
});
