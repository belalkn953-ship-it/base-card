const CACHE_NAME='base-card-offline-v9';
const APP_SHELL=[
  './','./index.html','./styles.css?v=38','./app.js?v=146',
  './supabase-config.js','./km-game-catalog.js?v=4','./my-payments.js?v=3',
  './account-security.js?v=6','./chatapps-fix-v6.js?v=21','./kmcard-ui.js?v=42',
  './transfer-fallback.js?v=8','./manifest.webmanifest'
];
const INDEX_URL=new URL('./index.html',self.registration.scope).href;
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('base-card-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
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
