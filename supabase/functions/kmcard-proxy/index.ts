import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const allowedOrigins = new Set([
  "https://belalkn953-ship-it.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);
const corsFor = (req)=>{
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://belalkn953-ship-it.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
};
const json = (data, status = 200, req)=>new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsFor(req || new Request("https://localhost")),
      "Content-Type": "application/json"
    }
  });
const base = "https://api.km-card.com";
const providerStatus = (x)=>{
  const v = x?.status ?? x?.state ?? x?.data?.status ?? x?.data?.state ?? (Array.isArray(x?.data) ? x.data[0]?.status : null) ?? 'wait';
  return String(v).toLowerCase();
};
const providerBalanceError = (x)=>/(insufficient|not enough|no balance|رصيد|balance|funds|credit)/i.test(JSON.stringify(x || ''));
const baseStatus = (s)=>s === 'wait' ? 'pending' : s;
const providerId = (x)=>x?.order_id ?? x?.data?.order_id ?? (Array.isArray(x?.data) ? x.data[0]?.order_id : null) ?? null;
const APPROVED_FREE_FIRE_IDS = new Set([276,277,14,20,23,27,31,426,431,436,437,1104]);
const APPROVED_CHAT_IDS = new Set([6,12,17,22,30,33,35,38,40,42,43,44,45,46,47,49,52,54,56,57,58,59,60,61,62,63,65,66,67,68,69,70,71,72,73,74,76,77,78,79,80,81,82,83,84,85,86,87,88,89,91,92,93,94,96,97,100,101,102,104,107,108,109,110,111,112,266,267,268,275,281,282,283,284,286,287,289,290,291,292,293,294,295,296,297,298,299,300,301,302,304,305,306,307,309,323,754,755,757,789,792,793,794,796,798,799,800,801,817,863,864,865,869,879,881,883,884,885,886,887,890,891,892,893,894,895,896,897,898,900,901,902,904,955,958,981,1010,1017,1037,1043,1048,1071,1085,1086,1087,1088,1089,1093,1094,1103,1105,1113]);
const APPROVED_PUBG_IDS = new Set([114,115,116,117,118,119,259,311,312,313,314,315,917,918,919,920,996,1018,1019,1020,1023,1024,1025,1027,1029,1030,1031]);
const PUBLIC_PRODUCT_IDS = new Set([...APPROVED_FREE_FIRE_IDS,...APPROVED_CHAT_IDS,...APPROVED_PUBG_IDS,4,11]);
const providerProductAllowed = (p)=>{
  const id = Number(p?.id);
  const category = String(p?.category_name || '').trim();
  if (id === 4 || id === 11) return true;
  if (/^FREE FIRE GLOBAL$/i.test(category)) return APPROVED_FREE_FIRE_IDS.has(id);
  if (/^PUBG GLOBAL$/i.test(category)) return APPROVED_PUBG_IDS.has(id);
  return Number(p?.parent_id) === 6 && APPROVED_CHAT_IDS.has(id);
};
const normalizeDigits = (v)=>String(v??'').replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).trim();
const validQuantity = (p, raw)=>{
  let q;try{q=scaledBigInt(raw,6)}catch(_){return false}
  if(q<=0n)return false;
  const values=p?.qty_values;
  if(p?.product_type==='specificPackage'||Array.isArray(values))return Array.isArray(values)&&values.some((v)=>{try{return scaledBigInt(v,6)===q}catch(_){return false}});
  if((p?.product_type==='amount'||p?.product_type==='package')&&values&&typeof values==='object'){
    try{return q>=scaledBigInt(values.min,6)&&q<=scaledBigInt(values.max,6)}catch(_){return false}
  }
  return q===1000000n;
};
const CHAT_MARGIN_NUM=114n, CHAT_MARGIN_DEN=100n, CHAT_COST_SCALE=1000000000000000000n, CHAT_QTY_SCALE=1000000n;
function scaledBigInt(value, scaleDigits){
  let text=normalizeDigits(value).toLowerCase();
  const match=text.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
  if(!match) throw new Error('invalid decimal');
  const sign=match[1]==='-'?-1n:1n, whole=match[2]||'0', fraction=match[3]||'', exponent=Number(match[4]||0);
  let digits=(whole+fraction).replace(/^0+(?=\d)/,'');
  let places=fraction.length-exponent;
  if(places<0){digits+='0'.repeat(-places);places=0;}
  if(places>scaleDigits){const cut=places-scaleDigits;const keep=Math.max(0,digits.length-cut);const rem=digits.slice(keep);digits=keep?digits.slice(0,keep):'0';if(/[1-9]/.test(rem))digits=(BigInt(digits)+1n).toString();places=scaleDigits;}
  return sign*BigInt((digits||'0')+'0'.repeat(scaleDigits-places));
}
function calculateChatSale(unitCost, quantity){
  const cost=scaledBigInt(unitCost,18), qty=scaledBigInt(quantity,6);
  if(cost<=0n||qty<=0n) throw new Error('invalid price or quantity');
  const numerator=cost*qty*CHAT_MARGIN_NUM, denominator=CHAT_COST_SCALE*CHAT_QTY_SCALE*CHAT_MARGIN_DEN;
  return ((numerator+denominator-1n)/denominator).toString();
}
const SECRET_PARAM_KEY='__basecard_encrypted_params_v1';
function isSensitiveParam(k){return /(password|passcode|كلمة\s*المرور|رمز\s*سري)/i.test(String(k));}
function bytesToBase64(bytes){let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary);}
function base64ToBytes(text){return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}
let encryptionKeyPromise;
async function encryptionKey(){
  if(!encryptionKeyPromise){const hex=Deno.env.get('KM_ORDER_ENCRYPTION_KEY')||'';if(!/^[a-f0-9]{64}$/i.test(hex))throw new Error('secure parameter storage unavailable');const raw=Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16)));encryptionKeyPromise=crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);}
  return encryptionKeyPromise;
}
async function protectParams(params){
  const secret={},clear={};for(const [k,v] of Object.entries(params||{}))(isSensitiveParam(k)?secret:clear)[k]=v;
  if(!Object.keys(secret).length)return clear;
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await encryptionKey();
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(secret)));
  return {...clear,[SECRET_PARAM_KEY]:{iv:bytesToBase64(iv),data:bytesToBase64(new Uint8Array(encrypted))}};
}
async function revealParams(params){
  const saved={...(params||{})},blob=saved[SECRET_PARAM_KEY];delete saved[SECRET_PARAM_KEY];if(!blob)return saved;
  const key=await encryptionKey(),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(blob.iv)},key,base64ToBytes(blob.data));
  return {...saved,...JSON.parse(new TextDecoder().decode(plain))};
}
function redactProviderResponse(result,params){
  let text=JSON.stringify(result??{});for(const [k,v] of Object.entries(params||{}))if(isSensitiveParam(k)&&v!==undefined&&v!==null&&String(v))text=text.split(String(v)).join('[redacted]');
  try{return JSON.parse(text)}catch{return {status:'redacted'}}
}
let providerCatalogCache={at:0,rows:[]};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsFor(req)
  });
  const token = Deno.env.get('KM_CARD_API_TOKEN');
  const supaUrl = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token) return json({
    error: 'KM Card API غير مضبوط'
  }, 500);
  let body = {};
  try {
    body = await req.json();
  } catch  {}
  const action = body.action || 'products';
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(supaUrl, anon, {
    global: {
      headers: {
        Authorization: auth
      }
    }
  });
  const admin = createClient(supaUrl, service);
  const audit = async (entry)=>{
    try {
      const { error } = await admin.from('kmcard_order_audit').insert(entry);
      if (error) console.error('[kmcard-proxy] audit write failed');
    } catch {
      console.error('[kmcard-proxy] audit write failed');
    }
  };
  const provider = async (path, init = {})=>{
    const r = await fetch(base + path, {
      ...init,
      headers: {
        ...init.headers || {},
        'api-token': token
      }
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch  {
      data = {
        status: 'ERROR',
        message: text
      };
    }
    ;
    if (!r.ok || data?.status === 'ERROR') throw new Error(data?.msg || data?.message || 'KM Card API error');
    return data;
  };
  const getProducts = async (force=false)=>{
    if(!force&&providerCatalogCache.rows.length&&Date.now()-providerCatalogCache.at<15000)return providerCatalogCache.rows;
    const data=await provider('/client/api/products');
    providerCatalogCache={at:Date.now(),rows:Array.isArray(data)?data:(data.data||[])};
    return providerCatalogCache.rows;
  };
  const finalize = async (row, result, status, forceRefund = false)=>{
    const final = await admin.rpc('finalize_kmcard_order', {
      p_id: Number(row.id),
      p_status: status,
      p_provider_order_id: providerId(result),
      p_response: result,
      p_refund: forceRefund || status === 'reject'
    });
    if (final.error) throw final.error;
    return final.data;
  };
  try {
    if (action === 'products') {
      const rows=await getProducts();
      const safeFields=['id','name','available','category_name','parent_id','params','product_type','qty_values'];
      return json({products:rows.filter(p=>PUBLIC_PRODUCT_IDS.has(Number(p.id))).map((p)=>Object.fromEntries(safeFields.filter((k)=>p[k]!==undefined).map((k)=>[k,p[k]])))});
    }
    if(action==='quote'){
      const productId=Number(body.product_id),rawQty=String(body.qty??'');
      const rows=await getProducts();const p=rows.find((x)=>Number(x.id)===productId&&x.available!==false);
      if(!p||Number(p.parent_id)!==6||!providerProductAllowed(p))return json({error:'المنتج غير متاح حاليًا'},400,req);
      if(!validQuantity(p,rawQty))return json({error:'الكمية غير صحيحة أو خارج حدود المنتج'},400,req);
      if(!Number(p.price)||Number(p.price)<=0)return json({error:'تعذر تحديد السعر حاليًا'},503,req);
      return json({sale_price_syp:calculateChatSale(p.price,rawQty),currency:'SYP',margin_percent:14},200,req);
    }
    // Called only by a trusted pg_cron/pg_net job. Never expose this to browser users.
    if (action === 'poll') {
      const cronSecret = Deno.env.get('KM_CRON_SECRET');
      const supplied = req.headers.get('x-cron-secret') || body.secret || '';
      if (!cronSecret || supplied !== cronSecret) return json({
        error: 'poll غير مصرح'
      }, 401);
      const { data: rows, error } = await admin.from('kmcard_orders').select('*').in('status', [
        'pending',
        'processing'
      ]).order('created_at').limit(50);
      if (error) throw error;
      const results = [];
      for (const row of rows || []){
        let result;
        let retryParams={};
        if (row.provider_order_id) {
          result = await provider(`/client/api/check?orders=${encodeURIComponent(JSON.stringify([
            row.provider_order_id
          ]))}`);
        } else {
          // Safe retry: the persisted UUID makes KM Card idempotent and prevents duplicate fulfillment.
          const q = new URLSearchParams({
            qty: String(row.quantity),
            order_uuid: String(row.order_uuid)
          });
          retryParams=await revealParams(row.params||{});
          for (const [k, v] of Object.entries(retryParams)){
            if (v !== undefined && v !== null) q.set(k, String(v));
          }
          result = await provider(`/client/api/newOrder/${Number(row.product_id)}/params?${q.toString()}`);
        }
        const rawStatus = providerStatus(row.provider_order_id ? (result?.data || [])[0] || result : result);
        const status = providerBalanceError(result) ? 'reject' : rawStatus;
        const safeResult=redactProviderResponse(result,retryParams);
        const final = await finalize(row, safeResult, baseStatus([
          'accept',
          'wait',
          'reject'
        ].includes(status) ? status : 'wait'));
        if (final?.status && final.status !== row.status) {
          await audit({
            user_id: row.user_id, request_id: crypto.randomUUID(), event_type: 'provider_status',
            product_id: Number(row.product_id), quantity: Number(row.quantity), order_id: Number(row.id),
            provider_status: String(final.provider_status || status), reason_code: 'polled_status_change'
          });
        }
        results.push({
          id: row.id,
          status: final?.status || status
        });
      }
      return json({
        ok: true,
        processed: results.length,
        results
      });
    }
    const { data: ud, error: ue } = await userClient.auth.getUser();
    if (ue || !ud.user) return json({
      error: 'سجّل الدخول أولًا'
    }, 401);
    if (action === 'my_orders') {
      // Rolling window: show only the user's orders from the last 24 hours.
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const [km, legacy] = await Promise.all([
        admin.from('kmcard_orders').select('order_number,status,provider_status,category_name,product_name,charged_syp,created_at,updated_at').eq('user_id', ud.user.id).gte('created_at', start).lt('created_at', end).order('created_at', {
          ascending: false
        }),
        admin.from('orders').select('order_number,status,game_id,package_id,created_at,updated_at').eq('user_id', ud.user.id).gte('created_at', start).lt('created_at', end).order('created_at', {
          ascending: false
        })
      ]);
      if (km.error && legacy.error) throw km.error;
      const packageIds=[...new Set((legacy.data||[]).map((x)=>Number(x.package_id)).filter(Number.isFinite))];
      const oldPackages=packageIds.length?await admin.from('packages').select('id,name,price,price_amount,currency').in('id',packageIds):{data:[]};
      const packageMap=new Map((oldPackages.data||[]).map((x)=>[Number(x.id),x]));
      return json({
        orders: [
          ...(km.data || []).map((x)=>({
              ...x,
              source: 'kmcard',
              title: x.category_name || 'KM Card',
              package_name: x.product_name,
              amount: x.charged_syp,
              currency: 'SYP'
            })),
          ...(legacy.data || []).map((x)=>{const pkg=packageMap.get(Number(x.package_id));return {
              ...x,
              source: 'legacy',
              title: 'طلب شحن',
              package_name: pkg?.name||'—',
              amount: Number(pkg?.price_amount??pkg?.price??0),
              currency: pkg?.currency||'SYP'
            }})
        ].sort((a, b)=>new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      }, 200, req);
    }
    if (action === 'order') {
      const requestId = crypto.randomUUID();
      const requested = body.product || {};
      const productId = Number(requested.id);
      const qtyRaw=String(body.qty??1);
      const qty = Number(qtyRaw);
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      if (!Number.isFinite(productId) || productId <= 0 || qty <= 0 || !Number.isFinite(qty)) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'validation_rejected',
          product_id: Number.isFinite(productId) ? productId : null,
          quantity: Number.isFinite(qty) ? qty : null, reason_code: 'invalid_product_or_quantity'
        });
        return json({ error: 'بيانات المنتج غير صالحة' }, 400, req);
      }
      const { data: rateCheck, error: rateError } = await admin.rpc('register_kmcard_order_attempt', {
        p_user_id: ud.user.id,
        p_request_id: requestId,
        p_product_id: productId,
        p_quantity: qty,
        p_limit: 10
      });
      if (rateError) {
        console.error('[kmcard-proxy] rate limiter unavailable');
        return json({ error: 'تعذر التحقق من حماية الطلب حاليًا؛ حاول بعد قليل' }, 503, req);
      }
      if (!rateCheck?.allowed) {
        return json({ error: 'أرسلت طلبات كثيرة خلال دقيقة؛ انتظر قليلًا ثم حاول مجددًا' }, 429, req);
      }
      // Never trust catalogue data or price supplied by the browser: resolve the product again from KM Card.
      const products=await getProducts(true);
      const p = products.find((x)=>Number(x.id) === productId && x.available !== false);
      if (!p || !providerProductAllowed(p) || !Number(p.price) || Number(p.price) <= 0) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'validation_rejected',
          product_id: productId, quantity: qty, reason_code: 'product_unavailable_or_not_allowed'
        });
        return json({ error: 'الباقة غير مدعومة أو غير متاحة حاليًا' }, 400, req);
      }
      if (!validQuantity(p, qtyRaw)) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'validation_rejected',
          product_id: productId, quantity: qty, reason_code: 'unsupported_quantity'
        });
        return json({ error: 'الكمية غير مدعومة لهذا المنتج' }, 400, req);
      }
      const isChatProduct=Number(p.parent_id)===6;
      if(isChatProduct){
        const serverQuote=calculateChatSale(p.price,qtyRaw);
        if(String(body.quoted_sale_price_syp??'')!==serverQuote)return json({error:'تغيّر السعر؛ حدّث السعر قبل الشراء'},409,req);
      }
      const required = Array.isArray(p.params) ? p.params.filter((k)=>String(k).trim()) : [];
      const missing = required.filter((k)=>{
        const v = params[String(k)];
        return v === undefined || v === null || String(v).trim() === '';
      });
      if (missing.length) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'validation_rejected',
          product_id: productId, quantity: qty, reason_code: 'required_fields_missing'
        });
        return json({ error: 'المعلومات غير صحيحة أو ناقصة، حاول مرة أخرى' }, 400, req);
      }
      const paramsWithPlayer=params;
      const storedParams=await protectParams(paramsWithPlayer);
      const created=isChatProduct
        ? await admin.rpc('create_kmcard_chat_order',{
            p_user_id:ud.user.id,p_product_id:Number(p.id),p_product_name:String(p.name||''),
            p_category_name:String(p.category_name||''),p_quantity:qtyRaw,
            p_provider_unit_cost_syp:String(p.price),p_params:storedParams,p_order_uuid:body.idempotency_key||null
          })
        : await userClient.rpc('create_kmcard_order',{
            p_product_id:Number(p.id),p_product_name:String(p.name||''),p_category_name:String(p.category_name||''),
            p_quantity:qty,p_price_usd:Number(p.price),p_params:storedParams,p_order_uuid:body.idempotency_key||null,p_sale_price_syp:null
          });
      if (created.error) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'order_creation_rejected',
          product_id: productId, quantity: qty, reason_code: 'wallet_price_or_order_validation'
        });
        const rawError=String(created.error.message||'');
        const safeError=/insufficient|wallet|الرصيد غير كافٍ/i.test(rawError)?'الرصيد غير كافٍ، اشحن محفظتك أولًا':/سعر البيع غير مضبوط|price/i.test(rawError)?'سعر هذه الباقة غير مضبوط حاليًا؛ تواصل مع الدعم':'تعذر إنشاء الطلب حاليًا';
        return json({ok:false,error:safeError,charged_syp:0,refunded:false},400,req);
      }
      const row = created.data;
      // A repeated browser submission returns the persisted order and never submits a second provider request.
      if (row?.already_exists && (row.provider_order_id || ['completed','rejected','refunded'].includes(String(row.status||'').toLowerCase()))) {
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'idempotent_repeat',
          product_id: productId, quantity: qty, order_id: Number(row.id),
          provider_status: String(row.provider_status || row.status), reason_code: 'same_order_uuid'
        });
        return json({
          ok: true,
          order_id: row.id,
          order_number: row.order_number,
          status: row.status,
          provider_status: row.provider_status,
          charged_syp: row.charged_syp,
          balance_after: row.balance_after ?? null,
          balance_currency: 'SYP'
        });
      }
      const q = new URLSearchParams({
        qty: String(qty),
        order_uuid: String(row.order_uuid)
      });
      for (const [k, v] of Object.entries(paramsWithPlayer)){
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
      let result;
      try {
        result = await provider(`/client/api/newOrder/${Number(p.id)}/params?${q.toString()}`);
      } catch (providerError) {
        const final = await finalize({id:Number(row.id)},{error:'provider_request_failed'},'reject',true);
        await audit({
          user_id: ud.user.id, request_id: requestId, event_type: 'provider_error',
          product_id: productId, quantity: qty, order_id: Number(row.id),
          provider_status: 'reject', reason_code: 'provider_request_failed'
        });
        return json({
          ok: false,
          order_id: row.id,
          order_number: row.order_number,
          status: final?.status || 'rejected',
          provider_status: 'reject',
          refunded: true,
          error: 'تواصل مع الدعم'
        });
      }
      const rawStatus = providerStatus(result);
      const providerLowBalance=providerBalanceError(result);
      const status = providerLowBalance ? 'reject' : rawStatus;
      const final = await finalize({
        id: Number(row.id)
      }, redactProviderResponse(result,paramsWithPlayer), baseStatus([
        'accept',
        'reject',
        'wait'
      ].includes(status) ? status : 'wait'));
      await audit({
        user_id: ud.user.id, request_id: requestId, event_type: 'provider_status',
        product_id: productId, quantity: qty, order_id: Number(row.id),
        provider_status: String(final?.provider_status || status), reason_code: 'initial_provider_response'
      });
      const {data: walletAfter}=await admin.from('wallets').select('balance_syp,balance_usd').eq('user_id',ud.user.id).maybeSingle();
      return json({
        ok: true,
        order_id: row.id,
        order_number: row.order_number,
        status: final?.status || status,
        provider_status: status,
        provider_order_id: providerId(result),
        charged_syp: row.charged_syp,
        balance_after: walletAfter?Number(walletAfter.balance_syp):null,
        balance_currency: 'SYP',
        ...(providerLowBalance?{error:'لا يوجد رصيد كافٍ لدى مزود الشحن حاليًا، تواصل مع الدعم'}:{})
      });
    }
    if (action === 'check' || action === 'check_number') {
      const rowId = Number(body.id);
      const orderNumber = String(body.order_number || '').trim();
      if (!rowId && !orderNumber) return json({
        error: 'رقم الطلب غير صالح'
      }, 400);
      let query = userClient.from('kmcard_orders').select('*').eq('user_id', ud.user.id);
      query = rowId ? query.eq('id', rowId) : query.eq('order_number', orderNumber);
      const { data: row, error: re } = await query.single();
      if (re || !row) return json({
        ok: false,
        not_found: true,
        order_number: orderNumber,
        status: 'pending'
      });
      if (!row.provider_order_id) return json({
        ok: true,
        order_number: row.order_number,
        status: row.status
      });
      const result = await provider(`/client/api/check?orders=${encodeURIComponent(JSON.stringify([
        row.provider_order_id
      ]))}`);
      const d = (result.data || [])[0] || result;
      const rawStatus = providerStatus(d);
      const status = providerBalanceError(d) ? 'reject' : rawStatus;
      const final = await finalize(row, result, baseStatus([
        'accept',
        'reject',
        'wait'
      ].includes(status) ? status : row.status));
      if (final?.status && final.status !== row.status) {
        await audit({
          user_id: ud.user.id, request_id: crypto.randomUUID(), event_type: 'provider_status',
          product_id: Number(row.product_id), quantity: Number(row.quantity), order_id: Number(row.id),
          provider_status: String(final.provider_status || status), reason_code: 'user_check_status_change'
        });
      }
      return json({
        ok: true,
        order_number: row.order_number,
        status: final?.status || status
      });
    }
    return json({
      error: 'إجراء غير معروف'
    }, 400);
  } catch (_e) {
    console.error('[kmcard-proxy] internal request error',_e instanceof Error?_e.name:'UnknownError');
    return json({
      ok: false,
      error: 'تعذر تنفيذ العملية حاليًا'
    }, 500, req);
  }
});
