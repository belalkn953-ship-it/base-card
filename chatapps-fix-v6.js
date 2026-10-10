(function(){
  'use strict';
  const endpoint=window.SUPABASE_URL+'/functions/v1/kmcard-proxy';
  const anon=window.SUPABASE_ANON_KEY;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isSensitive=k=>/(password|passcode|secret|token|verification|authentication|auth|security|login|sms|\botp\b|\b2fa\b|كلمة\s*المرور|رمز\s*(?:الدخول|سري|التحقق|المصادقة)|التحقق\s*الثنائي)/i.test(String(k));
  const normalizeSearchText=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/g,'').replace(/\u0640/g,'').replace(/[أإآٱ]/g,'ا').replace(/[ىی]/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^a-z0-9\u0600-\u06ff]+/g,' ').trim().replace(/\s+/g,' ');
  function phoneticSearchKey(value){let s=String(value??'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/g,'').replace(/\u0640/g,'').replace(/wh/g,'w').replace(/ph/g,'f').replace(/sh|ch|kh/g,'x').replace(/gh/g,'g').replace(/th/g,'t').replace(/[أإآٱا]/g,'a').replace(/ة/g,'a').replace(/[ىیي]/g,'y').replace(/و/g,'w').replace(/ء|ع/g,'').replace(/[بپ]/g,'b').replace(/[تثط]/g,'t').replace(/[دذض]/g,'d').replace(/[سص]/g,'s').replace(/[زظ]/g,'z').replace(/[حهه]/g,'h').replace(/[خش]/g,'x').replace(/غ/g,'g').replace(/[قك]/g,'k').replace(/[فڤ]/g,'f').replace(/ج/g,'j').replace(/ر/g,'r').replace(/ل/g,'l').replace(/م/g,'m').replace(/ن/g,'n').replace(/[^a-z0-9]/g,'').replace(/[gj]/g,'j').replace(/[ckq]/g,'k').replace(/[fv]/g,'f').replace(/[pb]/g,'b').replace(/[aeiouwy]/g,'').replace(/(.)\1+/g,'$1');return s;}
  const SEARCH_ALIAS_GROUPS=[['whatsapp','واتساب','واتس اب','واتسآب'],['telegram','تلغرام','تليغرام','تيليجرام'],['tiktok','تيك توك','تيكتوك'],['bigo','bigo live','بيجو','بيغو','بيجو لايف','بيغو لايف'],['tango','تانجو'],['imo','ايمو','إيمو'],['viber','فايبر'],['likee','لايكي'],['yalla','يلا']];
  function searchAliases(value){const compact=normalizeSearchText(value).replace(/\s/g,'');const out=[];for(const group of SEARCH_ALIAS_GROUPS){const keys=group.map(x=>normalizeSearchText(x).replace(/\s/g,''));if(keys.some(k=>compact.includes(k)))out.push(...group)}return out;}
  function searchForms(value){const raw=String(value??''),norm=normalizeSearchText(raw),forms=[norm,norm.replace(/\s/g,''),phoneticSearchKey(raw)];for(const alias of searchAliases(raw)){const n=normalizeSearchText(alias);forms.push(n,n.replace(/\s/g,''),phoneticSearchKey(alias));}return [...new Set(forms.filter(Boolean))];}
  function chatSearchBlob(p){return searchForms([p?.name||'',p?.category_name||'',...searchAliases(p?.name||'')].join(' ')).join(' ');}
  let products=[], byId=new Map(), search, productsLoaded=false, productsRefreshing=false, statusTimerStarted=false;

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
    if(!search){search=document.createElement('input');search.id='chatFixSearch';search.type='search';search.placeholder='ابحث عن التطبيق بالاسم';search.setAttribute('aria-label','البحث عن التطبيق');search.style.cssText='display:block;width:100%;max-width:520px;margin:0 0 18px;padding:13px 16px;border:1px solid #334155;border-radius:12px;background:#111827;color:#fff;font-size:16px;';grid.parentNode.insertBefore(search,grid);search.addEventListener('input',filter)}
    const panel=document.getElementById('chatFixPanel');
    if(!products.length)grid.innerHTML='<div class="panel km-status error">لا توجد تطبيقات متاحة حاليًا.</div>';
    else grid.innerHTML=products.map(p=>{const image=window.KM_CARD_IMAGES?.chatProducts?.[String(Number(p.id))];const visual=image?`<img class="km-card-catalog-image" data-group-src="${esc(image)}" alt="${esc(p.name||'تطبيق')}" width="96" height="96" decoding="async">`:'<span class="km-card-catalog-image-fallback" aria-hidden="true">💬</span>';const searchData=esc(chatSearchBlob(p));return `<button type="button" class="game-card chat-fix-card" data-chat-id="${Number(p.id)}" data-chat-search="${searchData}"><span class="badge">متوفر الآن</span>${visual}<h3>${esc(p.name||'تطبيق')}</h3><p>الباقات المتاحة لهذا التطبيق</p><span class="btn">عرض الباقات ←</span></button>`}).join('');
    document.getElementById('chatappsLoadMore')?.remove();
    grid.style.display='';search.style.display='block';
    window.loadBaseCardImageGroups?.(grid,12);
    grid.querySelectorAll('.chat-fix-card').forEach(b=>b.addEventListener('click',()=>openProduct(byId.get(Number(b.dataset.chatId)))));filter();
  }
  function filter(){const raw=(search?.value||'').trim(),term=normalizeSearchText(raw),keys=searchForms(raw);document.querySelectorAll('#chatappsGrid .chat-fix-card').forEach(b=>{const blob=b.dataset.chatSearch||searchForms(b.textContent).join(' ');b.style.display=(!term||keys.some(k=>k.length>0&&blob.includes(k)))?'':'none'})}
  function openProduct(p){
    if(!p)return;
    const section=document.getElementById('chatapps'),grid=document.getElementById('chatappsGrid');let panel=document.getElementById('chatFixPanel');
    if(!panel){panel=document.createElement('div');panel.id='chatFixPanel';panel.className='panel';panel.style.display='none';const container=section?.querySelector('.container');if(grid)grid.insertAdjacentElement('afterend',panel);else container?.appendChild(panel)}panel.dataset.chatProductId=String(Number(p.id));
    const lim=bounds(p), maxAttr=lim.huge?'':` max="${lim.max}"`, range=lim.huge?`الكمية مفتوحة — الحد الأدنى: ${lim.min.toLocaleString('ar-SY')}`:`الكمية المتاحة: ${lim.min.toLocaleString('ar-SY')}${lim.max!==lim.min?' إلى '+lim.max.toLocaleString('ar-SY'):''}`;
    const fields=(Array.isArray(p.params)?p.params:[]).map((k,i)=>`<label class="full">${esc(k)} *<input data-chat-param="${esc(k)}" ${isSensitive(k)?'type="password" autocomplete="new-password"':'type="text" autocomplete="off"'} maxlength="200" required></label>`).join('');
    const select=lim.exact?`<select id="chatFixQty" required>${lim.exact.map(q=>`<option value="${q}">${q.toLocaleString('ar-SY')}</option>`).join('')}</select>`:`<input id="chatFixQty" type="number" min="${lim.min}"${maxAttr} step="1" value="${lim.min}" required>`;
    panel.innerHTML=`<h3>💬 ${esc(p.name)}</h3><p class="muted">${range}</p><form id="chatFixForm">${fields}<label class="full">الكمية *${select}</label><p id="chatFixQtyError" style="color:#ef4444;font-weight:700;min-height:1.4em"></p><p id="chatFixTotal" class="price-note">جارٍ حساب السعر النهائي…</p><p class="muted">السعر المعروض هو المبلغ النهائي المخصوم من محفظتك.</p><button class="btn" id="chatFixBuy" type="submit" disabled>شراء وشحن</button><p class="muted duplicate-order-warning">لا تضغط على زر الشراء مرتين حتى لا يتم خصم رصيد إضافي من محفظتك.</p><p id="chatFixNote" class="muted" role="status"></p></form>`;
    panel.style.display='block';if(grid)grid.style.display='';if(search)search.style.display='block';
    const form=panel.querySelector('#chatFixForm'),qty=panel.querySelector('#chatFixQty'),total=panel.querySelector('#chatFixTotal'),err=panel.querySelector('#chatFixQtyError'),btn=panel.querySelector('#chatFixBuy'),note=panel.querySelector('#chatFixNote');
    let quoteValue=null,quotedQty='',timer=null,quoteSeq=0;
    const updateQuote=async()=>{
      const raw=numText(qty.value),number=Number(raw),seq=++quoteSeq;quoteValue=null;quotedQty='';btn.disabled=true;
      const belowMin=Number.isFinite(number)&&number<lim.min,aboveMax=Number.isFinite(number)&&Number.isFinite(lim.max)&&number>lim.max;if(!Number.isFinite(number)||belowMin||aboveMax||(lim.exact&&!lim.exact.includes(number))){err.textContent=belowMin?`أقل كمية مسموحة هي ${lim.min.toLocaleString('ar-SY')}.`:aboveMax?`أقصى كمية مسموحة هي ${lim.max.toLocaleString('ar-SY')}.`:`الكمية غير صحيحة؛ ${range}.`;total.textContent='';return}
      err.textContent='';total.textContent='جارٍ حساب السعر النهائي…';
      try{const q=await api({action:'quote',product_id:Number(p.id),qty:raw});if(seq!==quoteSeq)return;quoteValue=String(q.sale_price_syp);quotedQty=raw;total.innerHTML=`السعر النهائي: <b>${formatMoney(quoteValue)} ل.س جديدة</b>`;btn.disabled=!!form.dataset.submitting}
      catch(e){if(seq!==quoteSeq)return;total.textContent='تعذر حساب السعر الآن. حاول مجددًا.';err.textContent=friendly(e);btn.disabled=true}
    };
    const scheduleQuote=()=>{clearTimeout(timer);quoteValue=null;quotedQty='';btn.disabled=true;delete form.dataset.orderUuid;timer=setTimeout(updateQuote,250)};
    panel.updateChatAvailability=(id,available)=>{if(Number(id)!==Number(p.id))return;if(available===false){clearTimeout(timer);quoteSeq++;quoteValue=null;quotedQty='';btn.disabled=true;total.textContent='غير متاح';err.textContent='';note.textContent='غير متاح'}else{note.textContent='';scheduleQuote()}};
    qty.addEventListener('input',scheduleQuote);qty.addEventListener('change',scheduleQuote);
    form.addEventListener('input',e=>{if(e.target!==qty&& !form.dataset.submitting)delete form.dataset.orderUuid});
    updateQuote();
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(form.dataset.submitting==='1')return;
      form.dataset.submitting='1';btn.disabled=true;btn.textContent='جارٍ إرسال الطلب…';
      try{
        if(!quoteValue||quotedQty!==numText(qty.value)){await updateQuote();return}
        const params={};form.querySelectorAll('[data-chat-param]').forEach(x=>params[x.dataset.chatParam]=x.value.trim());
        if(Object.values(params).some(v=>!v)){note.textContent='المعلومات غير صحيحة أو ناقصة، حاول مرة أخرى';window.flashMessage?.(note.textContent,'error');return}
        const auth=await sb.auth.getUser();if(!auth.data?.user){note.textContent='سجّل الدخول عبر Google أولًا قبل الشراء';return}
        form.dataset.orderUuid||=crypto.randomUUID();
        const r=await sb.functions.invoke('kmcard-proxy',{body:{action:'order',product:{id:Number(p.id),name:p.name,category_name:p.category_name,params:p.params||[]},qty:numText(qty.value),params,quoted_sale_price_syp:quoteValue,idempotency_key:form.dataset.orderUuid}});
        if(r.data)window.applyWalletSnapshot?.(r.data);if(r.error){window.refreshBaseCardWallet?.(true);let detail=r.data?.error||'';try{detail ||= (await r.error.context?.clone?.().json())?.error||''}catch(_){}throw new Error(detail||r.error.message||'تعذر تنفيذ الطلب')}if(r.data?.error){window.refreshBaseCardWallet?.(true);throw new Error(r.data.error)}
        const number=r.data.order_number||r.data.order_id||'—';const status=r.data.status==='completed'?'مكتمل':r.data.status==='rejected'?'مرفوض وتم إرجاع الرصيد':'قيد المعالجة';
        const msg=`تم إنشاء الطلب ${number} — الحالة: ${status}`;note.textContent=msg;window.flashMessage?.(msg,r.data.status==='rejected'?'error':'success',5000);
        const recent=JSON.parse(localStorage.getItem('basecard_recent_km_orders')||'[]');recent.unshift({order_number:r.data.order_number||'',source:'kmcard',status:r.data.status||'processing',provider_status:r.data.provider_status||'wait',title:p.category_name||'خدمات الدردشة',package_name:p.name,amount:String(r.data.charged_syp??quoteValue),currency:'SYP',created_at:new Date().toISOString()});localStorage.setItem('basecard_recent_km_orders',JSON.stringify(recent.filter(x=>x.order_number).slice(0,30)));
        window.applyWalletSnapshot?.(r.data);delete form.dataset.orderUuid;await Promise.allSettled([window.refreshBaseCardWallet?.(),window.refreshBaseCardTrack?.()]);
      }catch(e){window.refreshBaseCardWallet?.(true);const msg=friendly(e);note.textContent=msg;window.flashMessage?.(msg,'error');if(/تغيّر السعر|تغير السعر/i.test(String(e.message||''))){total.textContent='جارٍ تحديث السعر النهائي…';scheduleQuote()}}
      finally{await window.waitForBaseCardMessagePaint?.();delete form.dataset.submitting;btn.disabled=!quoteValue||p.available===false;btn.textContent='شراء وشحن'}
    });
    const sectionOpen=section&&!section.classList.contains('section-hidden')&&section.style.display!=='none';if(!sectionOpen&&typeof openMainSection==='function')openMainSection('chatapps',true);requestAnimationFrame(()=>panel.scrollIntoView({behavior:'smooth',block:'start'}));
  }
  async function run(){
    const grid=document.getElementById('chatappsGrid');if(!grid||productsRefreshing)return;
    productsRefreshing=true;
    try{
      const received=window.getBaseCardProducts?await window.getBaseCardProducts(productsLoaded):((await api({action:'products'})).products||[]);
      const incoming=received.filter(p=>p&&Number.isSafeInteger(Number(p.id))&&Number(p.id)>0&&Number(p.parent_id)===6&&p.available!==false&&!(Array.isArray(p.params)&&p.params.some(isSensitive))).sort((a,b)=>Number(a.id)-Number(b.id));
      if(!productsLoaded){products=incoming;productsLoaded=true;byId=new Map(products.map(p=>[Number(p.id),p]));draw()}
      else{
        const signature=rows=>JSON.stringify(rows.map(p=>[Number(p.id),String(p.name||''),p.available,JSON.stringify(p.qty_values||null),JSON.stringify(p.params||[])]));
        if(signature(products)!==signature(incoming)){
          const panel=document.getElementById('chatFixPanel'),activeId=Number(panel?.dataset.chatProductId);
          products=incoming;byId=new Map(products.map(p=>[Number(p.id),p]));draw();
          const active=byId.get(activeId);if(active)panel?.updateChatAvailability?.(active.id,active.available);else if(panel)panel.style.display='none';
        }
      }
    }catch(_){if(!productsLoaded)grid.innerHTML='<div class="panel km-status error">تعذر تحميل التطبيقات الآن. حاول تحديث الصفحة.</div>'}
    finally{productsRefreshing=false}
    if(!statusTimerStarted){statusTimerStarted=true;setInterval(()=>{if(document.visibilityState==='visible')run()},60000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')run()});window.addEventListener('focus',run)}
  }
  document.addEventListener('DOMContentLoaded',run);setTimeout(run,1200);setTimeout(run,6000);
})();
