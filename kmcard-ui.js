/* KM Card live catalogue and order UI. All fulfillment goes through the authenticated Edge Function. */
(function(){'use strict';
const PROXY='kmcard-proxy';
const kmEsc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const km$=s=>document.querySelector(s);
const text=p=>[p?.name,p?.category_name,p?.parent_name,p?.category?.name,p?.parent?.name].filter(Boolean).join(' ');
const isServer2Product=p=>/(?:server\s*[_-]?\s*2|سيرفر\s*2)/i.test(text(p));
const PROVIDER={4:'Syriatel',11:'MTN'};
// Fixed denominations supplied by KM Card for product 11 (MTN) and 4 (Syriatel).
// Keep these fixed: do not derive denominations or prices from USD conversion.
const TRANSFER_QTY={11:['10','12','15','20','25','30','35','40','50','60','70','85','90','100','110','150','170','190','200','230','260','280','300','320','340','360','400','420','440','460','480','500','550','600','650','700','750','1000','1500','2000','2500','3000','3500','3600','4500','4800','5000','5500','6000','7200'],4:['1.92','2.88','3.84','4.8','5.76','9.61','20.19','23.07','24.03','25.96','30.76','40.38','45.19','48.07','52.88','62.5','68.26','72.11','77.88','81.73','86.53','96.15','100.96','105.76','115.38','130.76','144.23','160.57','163.46','173.07','183.65','192.3','211.53','240.38','288.46','317.3','370.19','432.69','480.76','576.92','721.15','769.23','951.92']};
const TRANSFER_MARGIN_SYP=10;
const isTransfer=p=>Object.prototype.hasOwnProperty.call(PROVIDER,Number(p?.id));
const isChat=p=>!isTransfer(p)&&(Number(p?.parent_id)===6||/(chat|whatsapp|telegram|messenger|live|hiyoo|migo|fancy|tango|yalla|party|discord|imo|viber|دردشة|شات|تطبيقات الدردشة)/i.test(text(p)));
const state={products:[],groups:{chat:[]},selectedProvider:null};
function ensureSections(){
 const back=km$('#sectionBack'); if(!back)return;
 if(!km$('#chatapps'))back.insertAdjacentHTML('afterend','<section id="chatapps" class="section" data-main-section="chatapps"><div class="container"><div class="section-title"><div><label>KM Card</label><h2>تطبيقات الدردشة</h2></div><p>اختر التطبيق لعرض الباقات.</p></div><div id="chatappsGrid" class="games-grid"><div class="panel km-status">جارٍ تحميل تطبيقات الدردشة...</div></div></div></section>');
 if(!km$('#transfer'))back.insertAdjacentHTML('afterend','<section id="transfer" class="section" data-main-section="transfer"><div class="container"><div class="section-title"><div><label>KM Card</label><h2>تحويل الرصيد</h2></div><p>اختر سيريتل أو MTN لعرض باقاتهما المباشرة.</p></div><div id="transferGrid" class="games-grid"></div><div id="transferFormPanel" class="panel hidden" style="margin-top:16px"></div></div></section>');
 if(typeof sectionNames!=='undefined'){sectionNames.chatapps='تطبيقات الدردشة';sectionNames.transfer='تحويل الرصيد';sectionTargets.chatapps='chatapps';sectionTargets.transfer='transfer';}
}
function group(list){const m=new Map();list.forEach(p=>{const n=String(p.category_name||p.parent_name||p.category?.name||p.parent?.name||p.name||'KM Card').trim();if(!m.has(n))m.set(n,[]);m.get(n).push(p)});return [...m].map(([name,products])=>({name,products}));}
function overrides(){let raw=window.__baseSettings?.km_sale_prices,map={};try{map=typeof raw==='string'?JSON.parse(raw||'{}'):(raw||{})}catch(_){}return map}
function comparablePrice(p,q){const map=overrides();for(const k of [`${p.id}:${q}`,`${p.id}_${q}`,`${p.id}-${q}`]){const n=Number(map[k]);if(Number.isFinite(n)&&n>=0)return n+TRANSFER_MARGIN_SYP}const v=p?.sale_price_syp??p?.comparable_price_syp??p?.provider_price_syp??p?.amount_syp;const n=Number(v);return v!==undefined&&v!==''&&Number.isFinite(n)?n+TRANSFER_MARGIN_SYP:null}
function qtyValues(p){return TRANSFER_QTY[Number(p?.id)]||[];}
function priceText(p,q){const n=comparablePrice(p,q);return n==null?'السعر يحدده المشرف من لوحة الإدارة':`${n.toLocaleString('ar-SY')} ل.س جديدة`}
function packageCard(p,q){return `<button type="button" class="package-card km-package" data-km-id="${Number(p.id)}" data-qty="${kmEsc(q??'')}" data-provider="${kmEsc(PROVIDER[Number(p.id)]||'')}"><span class="package-icon">📱</span><span class="package-name">${kmEsc(q??p.name||'باقة')} رصيد</span><span class="package-price">${priceText(p,q)}</span><span class="package-check">✓</span></button>`}
function providerCard(provider){return `<button type="button" class="game-card km-provider" data-provider="${provider}" aria-label="عرض باقات ${provider}"><span class="badge">متوفر الآن</span><h3>📱 ${provider==='MTN'?'MTN':'سيريتل'}</h3><p>باقات التحويل المباشر لـ ${provider==='MTN'?'MTN':'سيريتل'} فقط</p><span class="btn">عرض الباقات ←</span></button>`}
function draw(){const cg=km$('#chatappsGrid'),tg=km$('#transferGrid');if(cg)cg.innerHTML=state.groups.chat.length?state.groups.chat.map(g=>`<button type="button" class="game-card km-group" data-km-group="${kmEsc(g.name)}"><span class="badge">متوفر الآن</span><h3>💬 ${kmEsc(g.name)}</h3><p>${g.products.length} باقة متاحة</p><span class="btn">عرض الباقات ←</span></button>`).join(''):'<div class="panel km-status error">لم يعثر مزود الخدمة على تطبيقات دردشة متاحة حاليًا.</div>';if(tg){const ok4=state.products.some(x=>Number(x.id)===4),ok11=state.products.some(x=>Number(x.id)===11);tg.innerHTML=(ok4?providerCard('Syriatel'):'')+(ok11?providerCard('MTN'):'')||'<div class="panel km-status error">لا توجد منتجات تحويل مدعومة حاليًا.</div>'}}
async function submitKmOrder(p,qty,params,note,button){
 if(!p||!p.id){note.textContent='الباقة غير متاحة حاليًا.';return}
 button.disabled=true; note.textContent='جارٍ إنشاء الطلب وخصم الرصيد...';
 try{const idempotency_key=crypto.randomUUID();const r=await sb.functions.invoke(PROXY,{body:{action:'order',product:{id:Number(p.id),name:p.name,category_name:p.category_name,price:Number(p.price),params:p.params||[]},qty:Number(qty),params,idempotency_key}});if(r.error)throw Error(r.error.message||'تعذر إنشاء الطلب');if(r.data?.error)throw Error(r.data.error);note.textContent=`تم إنشاء الطلب ${r.data.order_number||''} — الحالة: ${r.data.status||'قيد المعالجة'}`;}
 catch(e){note.textContent=e.message||'تعذر تنفيذ الطلب.'} finally{button.disabled=false}
}
function showTransfer(provider){
 provider=provider==='MTN'?'MTN':'Syriatel'; state.selectedProvider=provider;
 const id=provider==='MTN'?11:4,p=state.products.find(x=>Number(x.id)===id);
 let panel=km$('#transferFormPanel'); if(!panel)return;
 if(!p){panel.innerHTML='<p class="km-status error">منتج التحويل غير متاح حاليًا من KM Card.</p>';panel.classList.remove('hidden');return}
 const cards=qtyValues(p).map(q=>packageCard(p,q)).join(''); panel.classList.remove('hidden','section-hidden');panel.style.display='block';
 panel.innerHTML=`<h3>شراء رصيد ${kmEsc(provider)}</h3><form id="transferPurchaseForm" novalidate><label class="full">رقم الهاتف السوري *<input id="transferTarget" name="phone" inputmode="tel" required placeholder="09xxxxxxxx أو +9639xxxxxxxx"><small class="muted">مطلوب لإتمام الشراء.</small></label><p class="muted">اختر كمية ثابتة مدعومة من KM Card.</p><div id="transferPackages" class="packages-grid">${cards}</div><button class="btn" type="submit">إرسال الطلب</button><p id="transferFormNote" class="muted" role="status"></p></form>`;
 const form=km$('#transferPurchaseForm');form.addEventListener('submit',e=>{e.preventDefault();const phone=km$('#transferTarget').value.trim(),note=km$('#transferFormNote'),sel=form.querySelector('.km-package.selected');if(!/^(?:0?9|\+?963|00963)9?\d{8}$/.test(phone.replace(/[\s-]/g,''))){note.textContent='أدخل رقمًا سوريًا صحيحًا مثل 09xxxxxxxx.';return}if(!sel){note.textContent='اختر كمية أولًا.';return}const key=String(p.params?.[0]||'رقم الهاتف');submitKmOrder(p,sel.dataset.qty,{[key]:phone},note,e.target.querySelector('button[type=submit]'))});panel.scrollIntoView({behavior:'smooth',block:'start'});
}
window.__openBaseCardTransfer=showTransfer;
function showChat(g){
 const section=km$('#chatapps'),panel=km$('#kmProviderPanel')||(()=>{const x=document.createElement('div');x.id='kmProviderPanel';x.className='panel';section?.querySelector('.container')?.appendChild(x);return x})(); if(!panel)return;
 panel.innerHTML=`<h3>💬 ${kmEsc(g.name)}</h3><p class="muted">اختر الباقة وأدخل المعرّف المطلوب.</p><div id="chatPackages" class="packages-grid">${g.products.map(p=>packageCard(p)).join('')}</div><form id="chatPurchaseForm"><label class="full">معرّف المستخدم *<input id="chatTarget" required maxlength="160"></label><label class="full">الكمية *<input id="chatQty" type="number" min="1" step="any" required></label><button class="btn" type="submit">إرسال الطلب</button><p id="chatFormNote" class="muted" role="status"></p></form>`;
 const form=km$('#chatPurchaseForm');form.addEventListener('submit',e=>{e.preventDefault();const sel=form.querySelector('.km-package.selected'),note=km$('#chatFormNote');if(!sel){note.textContent='اختر الباقة أولًا.';return}const p=g.products.find(x=>Number(x.id)===Number(sel.dataset.kmId));const key=String(p?.params?.[0]||'User ID');submitKmOrder(p,Number(km$('#chatQty').value),{[key]:km$('#chatTarget').value.trim()},note,form.querySelector('button[type=submit]'))});
 if(typeof openMainSection==='function')openMainSection('chatapps',true);panel.scrollIntoView({behavior:'smooth',block:'start'});
}
function parse(raw){const seen=new Set();function walk(v,d=0){if(d>8||v==null)return[];if(Array.isArray(v))return v.filter(x=>x&&typeof x==='object');if(typeof v!=='object'||seen.has(v))return[];seen.add(v);for(const k of ['products','items','results','data','result','payload'])if(v[k]!=null){const a=walk(v[k],d+1);if(a.length)return a}return[]}return walk(raw)}
async function load(){const cg=km$('#chatappsGrid');if(cg)cg.innerHTML='<div class="panel km-status">جارٍ تحميل تطبيقات الدردشة من KM Card...</div>';try{if(typeof sb==='undefined'||!sb.functions?.invoke)throw Error('تعذر تهيئة خدمة المزود');const r=await sb.functions.invoke(PROXY,{body:{action:'products'}});if(r.error)throw Error(r.error.message||'تعذر الاتصال بمزود الخدمة');const list=parse(r.data).filter(p=>p&&p.available!==false&&p.id!=null&&!isServer2Product(p));if(!list.length)throw Error('لم تصل منتجات من KM Card');state.products=list;state.groups.chat=group(list.filter(isChat));draw();window.__kmProducts=list}catch(e){draw();const msg=kmEsc(e.message||'حدث خطأ من مزود الخدمة.');document.querySelectorAll('#chatappsGrid').forEach(x=>x.innerHTML=`<div class="panel km-status error"><strong>تعذر تحميل منتجات الدردشة</strong><br>${msg}</div>`);}}
ensureSections();
// Wait for the live catalogue before rendering provider cards.
draw();
document.addEventListener('click',e=>{const pr=e.target.closest?.('.km-provider');if(pr){e.preventDefault();e.stopPropagation();showTransfer(pr.dataset.provider);return}const g=e.target.closest?.('.km-group');if(g){e.preventDefault();const x=state.groups.chat.find(v=>v.name===g.dataset.kmGroup);if(x)showChat(x);return}const p=e.target.closest?.('.km-package');if(p)document.querySelectorAll('.km-package').forEach(x=>x.classList.toggle('selected',x===p))},true);
load();
})();