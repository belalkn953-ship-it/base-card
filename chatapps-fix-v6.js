(function(){
  'use strict';
  const endpoint=window.SUPABASE_URL+'/functions/v1/kmcard-proxy';
  const anon=window.SUPABASE_ANON_KEY;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isSensitive=k=>/(password|passcode|كلمة\s*المرور|رمز\s*سري)/i.test(String(k));
  const APPROVED_CHAT_IDS=new Set([6,12,17,22,30,33,35,38,40,42,43,44,45,46,47,49,52,54,56,57,58,59,60,61,62,63,65,66,67,68,69,70,71,72,73,74,76,77,78,79,80,81,82,83,84,85,86,87,88,89,91,92,93,94,96,97,100,101,102,104,107,108,109,110,111,112,266,267,268,275,281,282,283,284,286,287,289,290,291,292,293,294,295,296,297,298,299,300,301,302,304,305,306,307,309,323,754,755,757,789,792,793,794,796,798,799,800,801,817,863,864,865,869,879,881,883,884,885,886,887,890,891,892,893,894,895,896,897,898,900,901,902,904,955,958,981,1010,1017,1037,1043,1048,1071,1085,1086,1087,1088,1089,1093,1094,1103,1105,1113]);
  let products=[], byId=new Map(), search;

  async function api(body){
    const r=await fetch(endpoint,{method:'POST',headers:{apikey:anon,Authorization:'Bearer '+anon,'Content-Type':'application/json'},body:JSON.stringify(body)});
    let data={};try{data=await r.json()}catch(_){}
    if(!r.ok||data?.error)throw new Error(data?.error||'تعذر إكمال الطلب حاليًا');
    return data;
  }
  function numText(v){return String(v??'').replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).trim()}
  function bounds(p){
    const q=p?.qty_values;
    if(q&&typeof q==='object'&&!Array.isArray(q)){
      const min=Math.max(1,Number(numText(q.min||1))),max=Number(numText(q.max||min));
      const huge=!Number.isFinite(max)||max>1000000;
      return {min:Number.isFinite(min)?min:1,max,huge};
    }
    if(Array.isArray(q)&&q.length){const vals=q.map(Number).filter(Number.isFinite);return {min:Math.min(...vals),max:Math.max(...vals),huge:false,exact:vals}}
    return {min:1,max:1,huge:false};
  }
  function formatMoney(value){
    try{return BigInt(String(value)).toLocaleString('ar-SY')}catch(_){return String(value)}
  }
  function friendly(err){
    const m=String(err?.message||err||'');
    if(/provider|مزود|رصيد.*مزود|تواصل مع الدعم/i.test(m))return 'لا يوجد رصيد كافٍ لدى مزود الشحن حاليًا، تواصل مع الدعم';
    if(/wallet|insufficient|رصيد غير كافٍ/i.test(m))return 'الرصيد غير كافٍ، اشحن محفظتك أولًا';
    if(/تغيّر السعر|تغير السعر|حدّث السعر/i.test(m))return 'تغيّر السعر؛ جارٍ تحديث السعر النهائي.';
    if(/required|ناقصة|غير صحيحة|معلومات|معرّف|كمية غير/i.test(m))return 'المعلومات غير صحيحة أو ناقصة، حاول مرة أخرى';
    return m.includes('متاح')?m:'تعذر تنفيذ الطلب حاليًا، حاول مرة أخرى';
  }
  function draw(){
    const grid=document.getElementById('chatappsGrid');if(!grid)return;
    if(!products.length){grid.innerHTML='<div class="panel km-status error">لا توجد تطبيقات متاحة حاليًا.</div>';return}
    grid.innerHTML=products.map(p=>`<button type="button" class="game-card chat-fix-card" data-chat-id="${Number(p.id)}" ${p.available===false?'disabled aria-disabled="true"':''}><span class="badge">${p.available===false?'غير متاح حاليًا':'متوفر الآن'}</span><h3>💬 ${esc(p.name||'تطبيق')}</h3><p>Product ID ${Number(p.id)} — باقة مستقلة</p><span class="btn">عرض الباقات ←</span></button>`).join('');
    if(!search){search=document.createElement('input');search.id='chatFixSearch';search.type='search';search.placeholder='ابحث عن التطبيق بالاسم أو Product ID';search.setAttribute('aria-label','البحث عن التطبيق');search.style.cssText='display:block;width:100%;max-width:520px;margin:0 0 18px;padding:13px 16px;border:1px solid #334155;border-radius:12px;background:#111827;color:#fff;font-size:16px;';grid.parentNode.insertBefore(search,grid);search.addEventListener('input',filter)}
    filter();grid.querySelectorAll('.chat-fix-card').forEach(b=>b.addEventListener('click',()=>openProduct(byId.get(Number(b.dataset.chatId)))));
  }
  function filter(){const term=(search?.value||'').trim().toLocaleLowerCase();document.querySelectorAll('#chatappsGrid .chat-fix-card').forEach(b=>b.style.display=(!term||b.textContent.toLocaleLowerCase().includes(term))?'':'none')}
  function openProduct(p){
    if(!p)return;
    const section=document.getElementById('chatapps');let panel=document.getElementById('chatFixPanel');
    if(!panel){panel=document.createElement('div');panel.id='chatFixPanel';panel.className='panel';section?.querySelector('.container')?.appendChild(panel)}
    const lim=bounds(p), maxAttr=lim.huge?'':` max="${lim.max}"`, range=lim.huge?`الحد الأدنى: ${lim.min.toLocaleString('ar-SY')} — الحد الأعلى محفوظ لدى المزوّد`:`الكمية المتاحة: ${lim.min.toLocaleString('ar-SY')}${lim.max!==lim.min?' إلى '+lim.max.toLocaleString('ar-SY'):''}`;
    const fields=(Array.isArray(p.params)?p.params:[]).map((k,i)=>`<label class="full">${esc(k)} *<input data-chat-param="${esc(k)}" ${isSensitive(k)?'type="password" autocomplete="new-password"':'type="text" autocomplete="off"'} maxlength="200" required></label>`).join('');
    const select=lim.exact?`<select id="chatFixQty" required>${lim.exact.map(q=>`<option value="${q}">${q.toLocaleString('ar-SY')}</option>`).join('')}</select>`:`<input id="chatFixQty" type="number" min="${lim.min}"${maxAttr} step="1" value="${lim.min}" required>`;
    panel.innerHTML=`<h3>💬 ${esc(p.name)}</h3><p class="muted">${range}</p><form id="chatFixForm">${fields}<label class="full">الكمية *${select}</label><p id="chatFixQtyError" style="color:#ef4444;font-weight:700;min-height:1.4em"></p><p id="chatFixTotal" class="price-note">جارٍ حساب السعر النهائي…</p><p class="muted">السعر المعروض هو المبلغ النهائي المخصوم من محفظتك.</p><button class="btn" id="chatFixBuy" type="submit" disabled>شراء وشحن</button><p class="muted duplicate-order-warning">لا تضغط على زر الشراء مرتين حتى لا يتم خصم رصيد إضافي من محفظتك.</p><p id="chatFixNote" class="muted" role="status"></p></form>`;
    const form=panel.querySelector('#chatFixForm'),qty=panel.querySelector('#chatFixQty'),total=panel.querySelector('#chatFixTotal'),err=panel.querySelector('#chatFixQtyError'),btn=panel.querySelector('#chatFixBuy'),note=panel.querySelector('#chatFixNote');
    let quoteValue=null,quotedQty='',timer=null,quoteSeq=0;
    const updateQuote=async()=>{
      const raw=numText(qty.value),number=Number(raw),seq=++quoteSeq;quoteValue=null;quotedQty='';btn.disabled=true;
      if(!Number.isFinite(number)||number<lim.min||(!lim.huge&&number>lim.max)||(lim.exact&&!lim.exact.includes(number))){err.textContent=`الكمية غير صحيحة؛ ${range}.`;total.textContent='';return}
      err.textContent='';total.textContent='جارٍ حساب السعر النهائي…';
      try{const q=await api({action:'quote',product_id:Number(p.id),qty:raw});if(seq!==quoteSeq)return;quoteValue=String(q.sale_price_syp);quotedQty=raw;total.innerHTML=`السعر النهائي: <b>${formatMoney(quoteValue)} ل.س جديدة</b>`;btn.disabled=false}
      catch(e){if(seq!==quoteSeq)return;total.textContent='تعذر حساب السعر الآن. حاول مجددًا.';err.textContent=friendly(e);btn.disabled=true}
    };
    const scheduleQuote=()=>{clearTimeout(timer);quoteValue=null;quotedQty='';btn.disabled=true;delete form.dataset.orderUuid;timer=setTimeout(updateQuote,250)};
    qty.addEventListener('input',scheduleQuote);qty.addEventListener('change',scheduleQuote);
    form.addEventListener('input',e=>{if(e.target!==qty&& !form.dataset.submitting)delete form.dataset.orderUuid});
    updateQuote();
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(!quoteValue||quotedQty!==numText(qty.value)){await updateQuote();return}
      const params={};form.querySelectorAll('[data-chat-param]').forEach(x=>params[x.dataset.chatParam]=x.value.trim());
      if(Object.values(params).some(v=>!v)){note.textContent='المعلومات غير صحيحة أو ناقصة، حاول مرة أخرى';window.flashMessage?.(note.textContent,'error');return}
      const auth=await sb.auth.getUser();if(!auth.data?.user){note.textContent='سجّل الدخول عبر Google أولًا قبل الشراء';return}
      btn.disabled=true;btn.textContent='جارٍ إرسال الطلب…';form.dataset.submitting='1';form.dataset.orderUuid||=crypto.randomUUID();
      try{
        const r=await sb.functions.invoke('kmcard-proxy',{body:{action:'order',product:{id:Number(p.id),name:p.name,category_name:p.category_name,params:p.params||[]},qty:numText(qty.value),params,quoted_sale_price_syp:quoteValue,idempotency_key:form.dataset.orderUuid}});
        if(r.error){let detail=r.data?.error||'';try{detail ||= (await r.error.context?.clone?.().json())?.error||''}catch(_){}throw new Error(detail||r.error.message||'تعذر تنفيذ الطلب')}if(r.data?.error)throw new Error(r.data.error);
        const number=r.data.order_number||r.data.order_id||'—';const status=r.data.status==='completed'?'مكتمل':r.data.status==='rejected'?'مرفوض وتم إرجاع الرصيد':'قيد المعالجة';
        const msg=`تم إنشاء الطلب ${number} — الحالة: ${status}`;note.textContent=msg;window.flashMessage?.(msg,r.data.status==='rejected'?'error':'success',5000);
        const recent=JSON.parse(localStorage.getItem('basecard_recent_km_orders')||'[]');recent.unshift({order_number:r.data.order_number||'',source:'kmcard',status:r.data.status||'processing',provider_status:r.data.provider_status||'wait',title:p.category_name||'خدمات الدردشة',package_name:p.name,amount:String(r.data.charged_syp??quoteValue),currency:'SYP',created_at:new Date().toISOString()});localStorage.setItem('basecard_recent_km_orders',JSON.stringify(recent.filter(x=>x.order_number).slice(0,30)));
        delete form.dataset.orderUuid;await Promise.allSettled([window.refreshBaseCardWallet?.(),window.refreshBaseCardTrack?.()]);
      }catch(e){const msg=friendly(e);note.textContent=msg;window.flashMessage?.(msg,'error');if(/تغيّر السعر|تغير السعر/i.test(String(e.message||''))){total.textContent='جارٍ تحديث السعر النهائي…';scheduleQuote()}}
      finally{delete form.dataset.submitting;btn.disabled=!quoteValue;btn.textContent='شراء وشحن'}
    });
    if(typeof openMainSection==='function')openMainSection('chatapps',true);panel.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function run(){
    const grid=document.getElementById('chatappsGrid');if(!grid)return;
    try{const r=await api({action:'products'});products=(r.products||[]).filter(p=>Number(p.parent_id)===6&&APPROVED_CHAT_IDS.has(Number(p.id))&&p.id!=null).sort((a,b)=>Number(a.id)-Number(b.id));byId=new Map(products.map(p=>[Number(p.id),p]));draw()}
    catch(_){grid.innerHTML='<div class="panel km-status error">تعذر تحميل التطبيقات الآن. حاول تحديث الصفحة.</div>'}
  }
  document.addEventListener('DOMContentLoaded',run);setTimeout(run,1200);setTimeout(run,6000);
})();
