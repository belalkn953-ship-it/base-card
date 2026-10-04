import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SITE = "https://belalkn953-ship-it.github.io/base-card/";
const FREE_FIRE_NAMES: Record<number,string> = {
  276:"باقة 110 جوهرة (100 + 10 بونص)",
  277:"باقة 231 جوهرة",
  14:"باقة 583 جوهرة",
  20:"باقة 1166 جوهرة",
  23:"باقة 2398 جوهرة",
  27:"العضوية الأسبوعية",
  31:"العضوية الشهرية",
  426:"ترقية المستوى 6",
  431:"ترقية المستوى 10",
  436:"ترقية المستوى 20",
  1104:"ترقية المستوى 25",
  437:"ترقية المستوى 30"
};
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "fcmregistrations.googleapis.com",
  "web.push.apple.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  "notify.windows.com",
  "webpush.azure.com"
];
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), {
  status,
  headers: {"Content-Type":"application/json","Cache-Control":"no-store"}
});
const isAllowedEndpoint = (endpoint: string) => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
};
const fmt = (n: unknown, locale="ar-SY") => {
  const v=Number(n);
  return Number.isFinite(v) ? new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(v) : "—";
};
function findPlayerName(value: unknown, depth=0): string {
  if(depth>5 || !value || typeof value!=="object") return "";
  for(const [key,val] of Object.entries(value as Record<string,unknown>)){
    if(/^(player_?name|player_?nickname|nickname|nick_?name|ign|character_?name|in_?game_?name|ingame_?name|game_?username)$/i.test(key)
      && typeof val==="string"){
      const name=val.replace(/[\u0000-\u001f\u007f]/g,"").trim();
      if(name && name.length<=48 && !/^\d+$/.test(name)) return name;
    }
    if(val && typeof val==="object"){
      const found=findPlayerName(val,depth+1);
      if(found) return found;
    }
  }
  return "";
}
const SAFE_TARGET_KEYS=new Set(["userid","useridhere","playerid","playeridhere","uid","gameid","ايدياللاعب","أيدياللاعب","ايديالمستخدم","أيديالمستخدم","ايديالمسنخدم","ايديالمستحدم","معرفالمستخدم","معرّفالمستخدم","معرفاللاعب","معرّفاللاعب"]);
function findTargetId(params: unknown,productId: unknown,category: unknown): string {
  if([4,11].includes(Number(productId))||/syriatel|mtn|ام\s*تي\s*ان/i.test(String(category||""))) return "";
  if(!params||typeof params!=="object"||Array.isArray(params)) return "";
  for(const [key,value] of Object.entries(params as Record<string,unknown>)){
    const normalized=key.toLowerCase().replace(/[\s_:-]+/g,"");
    if(!SAFE_TARGET_KEYS.has(normalized)||(typeof value!=="string"&&typeof value!=="number")) continue;
    const id=String(value).replace(/[\u0000-\u001f\u007f]/g,"").trim();
    if(id&&id.length<=80) return id;
  }
  return "";
}
function gameAndPackage(order: Record<string,unknown>) {
  const id=Number(order.product_id);
  const category=String(order.category_name||"");
  if(/free\s*fire/i.test(category) || FREE_FIRE_NAMES[id])
    return {game:"فري فاير",pack:FREE_FIRE_NAMES[id]||String(order.product_name||"باقة شحن")};
  if(/pubg/i.test(category))
    return {game:"ببجي موبايل",pack:String(order.product_name||"باقة شحن").replace(/\bUC\b/g,"شدّة")};
  return {game:category||"طلب الشحن",pack:String(order.product_name||"باقة الشحن")};
}
function makeLegacyOrderNotice(order: Record<string,unknown>) {
  const game=String(order.game_name||"اللعبة");
  const pack=String(order.package_name||"الباقة");
  const status=String(order.status||"").toLowerCase();
  const targetId=String(order.player_id||"").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,80);
  if(status==="completed") return {title:"طلبك مكتمل ✅",body:`${game} — ${pack}${targetId?` — المعرّف: ${targetId}`:""}`,url:`${SITE}?from_notification=1#track`};
  return {title:"تحديث طلب الشحن",body:`رُفض طلب ${game} — ${pack} ❌ وأُعيد المبلغ إلى محفظتك.`,url:`${SITE}?from_notification=1#track`};
}
function makeNotice(eventType: string, row: Record<string,unknown>) {
  if(eventType==="topup"){
    const amount=fmt(row.amount),currency=String(row.currency||"SYP").toUpperCase();
    if(row.status==="approved"){
      const credited=Number(row.credited_amount||0);
      const body=currency==="USD"
        ? `تم قبول طلبك بقيمة $${fmt(row.amount,"en-US")} ✅ أُضيف ${credited?`${fmt(credited)} ل.س إلى محفظتك`:"الرصيد المقابل بالليرة إلى محفظتك"} 💰`
        : `تم قبول طلبك ✅ أُضيف ${amount} ليرة سورية جديدة إلى محفظتك 💰`;
      return {title:"تم قبول طلب شراء النقاط ✅",body,url:`${SITE}?from_notification=1#wallet`};
    }
    const amountLabel=currency==="USD"?`$${fmt(row.amount,"en-US")}`:`${amount} ل.س`;
    return {title:"تحديث طلب شراء النقاط",body:`رُفض طلبك بقيمة ${amountLabel} ❌ راجع رقم العملية أو تواصل مع الدعم.`,url:`${SITE}?from_notification=1#wallet`};
  }
  const {game,pack}=gameAndPackage(row);
  const playerName=findPlayerName(row.provider_response);
  const targetId=findTargetId(row.params,row.product_id,row.category_name);
  if(["completed","accept","accepted"].includes(String(row.status||"").toLowerCase())){
    const extra=playerName?` اسم اللاعب: ${playerName}.`:"";
    const extraId=targetId?` معرّف اللاعب/المستخدم: ${targetId}.`:"";
    return {title:"طلبك مكتمل ✅",body:`${game} — ${pack}.${extra}${extraId}`,url:`${SITE}?from_notification=1#track`};
  }
  const extra=playerName?` اسم اللاعب: ${playerName}.`:"";
  return {title:"تعذر إكمال طلب الشحن",body:`لم يكتمل طلب ${game} — ${pack}.${extra} ❌ وأُعيد المبلغ إلى محفظتك.`,url:`${SITE}?from_notification=1#track`};
}

Deno.serve(async (req)=>{
  if(req.method!=="POST") return json({error:"method_not_allowed"},405);
  const webhookSecret=Deno.env.get("ADMIN_PUSH_WEBHOOK_SECRET")||"";
  const supplied=req.headers.get("x-admin-push-secret")||"";
  if(!webhookSecret || supplied.length!==webhookSecret.length || supplied!==webhookSecret)
    return json({error:"unauthorized"},401);

  const publicKey=Deno.env.get("VAPID_PUBLIC_KEY")||"";
  const privateKey=Deno.env.get("VAPID_PRIVATE_KEY")||"";
  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!publicKey || !privateKey || !supabaseUrl || !serviceKey)
    return json({error:"push_service_not_configured"},500);

  let body: Record<string,unknown>;
  try { body=await req.json(); } catch { return json({error:"invalid_json"},400); }
  if(body.action==="health"){
    let keyPairValid=false;
    try{webpush.setVapidDetails(SITE,publicKey,privateKey);keyPairValid=true}catch(_){keyPairValid=false}
    return json({ok:true,vapid_public_key_matches:publicKey==="BOhOHy7ksU9bMr2Km-BHa-dn09zJ3qPw68WeDrWgfogDQ7GgPe0PHFsFjlHaAk3SmH9mP7GHragD0RM5HNLowSg",vapid_key_pair_valid:keyPairValid,web_push_runtime:true});
  }
  if(body.action==="test"){
    const userId=String(body.user_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(userId)) return json({error:"invalid_test_target"},400);
    const testAdmin=createClient(supabaseUrl,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
    const {data:profile,error:pError}=await testAdmin.from("profiles").select("role").eq("id",userId).maybeSingle();
    if(pError||profile?.role!=="admin") return json({error:"test_target_not_admin"},403);
    const {data:subs,error:sError}=await testAdmin.from("customer_push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id",userId).limit(10);
    if(sError) return json({error:"subscription_lookup_failed"},500);
    if(!subs?.length) return json({ok:true,sent:0,failed:0});
    webpush.setVapidDetails(SITE,publicKey,privateKey);
    const testUrl=`${SITE}?from_notification=1#track`;
    const payload=JSON.stringify({audience:"customer",type:"customer_test",title:"اختبار إشعارات Base Card",body:"هذه رسالة اختبار للتأكد من وصول الإشعارات. لم يتم إنشاء طلب أو خصم رصيد.",url:testUrl,data:{audience:"customer",type:"customer_test",url:testUrl}});
    let sent=0,failed=0;
    for(const sub of subs){
      if(!isAllowedEndpoint(String(sub.endpoint||""))){failed++;await testAdmin.from("customer_push_subscriptions").delete().eq("id",sub.id);continue;}
      try{await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload,{TTL:60});sent++;}
      catch(err){const code=Number((err as {statusCode?:number})?.statusCode||0);if(code===404||code===410)await testAdmin.from("customer_push_subscriptions").delete().eq("id",sub.id);failed++;}
    }
    return json({ok:true,sent,failed});
  }
  const eventId=Number(body.event_id),eventType=String(body.event_type||""),recordId=Number(body.record_id);
  if(!Number.isSafeInteger(eventId)||eventId<=0||!Number.isSafeInteger(recordId)||recordId<=0||!(["topup","kmcard_order","legacy_order"].includes(eventType)))
    return json({error:"invalid_event"},400);

  const admin=createClient(supabaseUrl,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
  try {
    const {data:queued,error:qError}=await admin.from("customer_push_event_queue").select("id,event_type,record_id,status,attempts").eq("id",eventId).maybeSingle();
    if(qError||!queued) return json({error:"event_not_found"},404);
    if(queued.event_type!==eventType||Number(queued.record_id)!==recordId) return json({error:"event_mismatch"},400);
    if(queued.status==="sent"||queued.status==="no_subscribers") return json({ok:true,duplicate:true,sent:queued.sent_count||0});
    await admin.from("customer_push_event_queue").update({status:"sending",attempts:Number(queued.attempts||0)+1,last_error:null}).eq("id",eventId);

    let userId="",notice:{title:string;body:string;url:string}|null=null;
    if(eventType==="topup"){
      const {data:topup,error}=await admin.from("topup_requests").select("id,user_id,amount,currency,status").eq("id",recordId).maybeSingle();
      if(error||!topup||!["approved","rejected"].includes(String(topup.status))) throw new Error("topup_not_final");
      userId=String(topup.user_id||"");
      let creditedAmount=0;
      if(topup.status==="approved"){
        const {data:tx}=await admin.from("wallet_transactions").select("amount").eq("reference_type","topup").eq("reference_id",recordId).maybeSingle();
        creditedAmount=Number(tx?.amount||0);
      }
      notice=makeNotice("topup",{...topup,credited_amount:creditedAmount});
    } else if(eventType==="kmcard_order") {
      const {data:order,error}=await admin.from("kmcard_orders").select("id,user_id,product_id,product_name,category_name,status,provider_status,provider_response,params").eq("id",recordId).maybeSingle();
      if(error||!order||!["completed","rejected","refunded"].includes(String(order.status))) throw new Error("order_not_final");
      userId=String(order.user_id||"");
      notice=makeNotice("kmcard_order",order);
    } else {
      const {data:order,error}=await admin.from("orders").select("id,user_id,game_id,package_id,player_id,status").eq("id",recordId).maybeSingle();
      if(error||!order||!["completed","rejected"].includes(String(order.status))) throw new Error("legacy_order_not_final");
      const [{data:game,error:gameError},{data:pack,error:packError}]=await Promise.all([
        admin.from("games").select("name").eq("id",order.game_id).maybeSingle(),
        admin.from("packages").select("name").eq("id",order.package_id).maybeSingle()
      ]);
      if(gameError||packError) throw new Error("legacy_order_details_unavailable");
      userId=String(order.user_id||"");
      notice=makeLegacyOrderNotice({...order,game_name:game?.name,package_name:pack?.name});
    }
    if(!userId||!notice) throw new Error("notification_recipient_missing");

    const {data:subs,error:sError}=await admin.from("customer_push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id",userId).limit(10);
    if(sError) throw new Error("subscription_lookup_failed");
    if(!subs?.length){
      await admin.from("customer_push_event_queue").update({status:"no_subscribers",sent_count:0,last_error:"no_subscriptions"}).eq("id",eventId);
      return json({ok:true,sent:0});
    }

    webpush.setVapidDetails(SITE,publicKey,privateKey);
    const payload=JSON.stringify({
      audience:"customer",
      type:eventType==="topup"?"customer_topup":"customer_order",
      title:notice.title,
      body:notice.body,
      url:notice.url,
      data:{audience:"customer",type:eventType==="topup"?"customer_topup":"customer_order",url:notice.url}
    });
    let sent=0,failed=0;
    for(const sub of subs){
      if(!isAllowedEndpoint(String(sub.endpoint||""))){
        failed++;
        await admin.from("customer_push_subscriptions").delete().eq("id",sub.id);
        continue;
      }
      try{
        await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload,{TTL:86400});
        sent++;
      }catch(err){
        const code=Number((err as {statusCode?:number})?.statusCode||0);
        if(code===404||code===410) await admin.from("customer_push_subscriptions").delete().eq("id",sub.id);
        failed++;
      }
    }
    await admin.from("customer_push_event_queue").update({status:sent?"sent":"failed",sent_count:sent,last_error:sent?null:`push_failed_${failed}`}).eq("id",eventId);
    return json({ok:true,sent,failed});
  } catch(err) {
    const reason=err instanceof Error?err.message:"notification_failed";
    await admin.from("customer_push_event_queue").update({status:"failed",last_error:reason.slice(0,120)}).eq("id",eventId);
    return json({error:"notification_failed"},500);
  }
});
