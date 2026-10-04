const CACHE_NAME='base-card-offline-v34';
const APP_SHELL=[
  './','./index.html','./styles.css?v=50','./app.js?v=166',
  './supabase-config.js','./km-game-catalog.js?v=4','./km-images.js?v=5','./my-payments.js?v=3',
  './account-security.js?v=6','./chatapps-fix-v6.js?v=28','./kmcard-ui.js?v=45',
  './transfer-fallback.js?v=9','./manifest.webmanifest?v=2','./icon-192.png?v=2','./icon-512.png?v=2','./icon-192-maskable.png?v=2','./icon-512-maskable.png?v=2'
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
function customerNotificationUrl(candidate,section){
  const fallback=new URL(`./index.html?from_notification=1#${section}`,self.registration.scope);
  try{
    const target=new URL(candidate||fallback.href,self.registration.scope);
    const scopePath=new URL(self.registration.scope).pathname;
    const hash=target.hash.replace(/^#/,'');
    return target.origin===self.location.origin&&target.pathname.startsWith(scopePath)&&/^(wallet|track)$/.test(hash)?target.href:fallback.href;
  }catch(_){return fallback.href}
}
self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?event.data.json():{}}catch(_){payload={body:event.data?.text?.()||''}}
  if(!payload||typeof payload!=='object')payload={body:String(payload)};
  const data=payload.data&&typeof payload.data==='object'?payload.data:{};
  const info=payload.notification&&typeof payload.notification==='object'?payload.notification:payload;
  const eventType=[payload.type,payload.event_type,payload.table,data.type,data.table].filter(Boolean).join(' ').toLowerCase();
  const audience=String(payload.audience||info.audience||data.audience||'').toLowerCase();
  const isCustomer=audience==='customer'||eventType.includes('customer_');
  const tab=/top.?up|deposit|wallet/.test(eventType)?'topups':/support|message/.test(eventType)?'messages':'topups';
  const section=/top.?up|deposit|wallet/.test(eventType)?'wallet':'track';
  const title=String(info.title||payload.title||data.title||'تنبيه من Base Card').slice(0,80);
  const body=String(info.body||info.message||payload.body||payload.message||data.body||data.message||'وصل طلب شحن أو رسالة دعم جديدة إلى الموقع.').slice(0,220);
  const url=isCustomer?customerNotificationUrl(info.url||payload.url||data.url,section):adminNotificationUrl(info.url||payload.url||data.url,tab);
  const options={body,icon:new URL('./icon-192.png?v=2',self.registration.scope).href,badge:new URL('./icon-192.png?v=2',self.registration.scope).href,data:{url,eventType,audience:isCustomer?'customer':'admin'}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const data=event.notification.data||{};
  const target=String(data.audience||'').toLowerCase()==='customer'
    ?customerNotificationUrl(data.url,/top.?up|wallet/.test(String(data.eventType||''))?'wallet':'track')
    :adminNotificationUrl(data.url,'topups');
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
