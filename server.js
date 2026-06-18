
const express=require("express");
const session=require("express-session");
const path=require("path");
const crypto=require("crypto");
const {google}=require("googleapis");
const {createClient}=require("@supabase/supabase-js");
const app=express(); const PORT=process.env.PORT||3000;
app.set("trust proxy",1); app.use(express.json());
app.use(session({secret:process.env.SESSION_SECRET||"dev_secret_change_me",resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production"||process.env.VERCEL==="1"}}));
app.use(express.static(path.join(__dirname,"public")));
const META_GRAPH_VERSION=process.env.META_GRAPH_VERSION||"v20.0";
const PINTEREST_API_BASE="https://api.pinterest.com/v5";
const KLAVIYO_API_BASE="https://a.klaviyo.com";
const KLAVIYO_WWW_BASE="https://www.klaviyo.com";
const GOOGLE_ADS_API_VERSION=process.env.GOOGLE_ADS_API_VERSION||"v24";
const supabaseAdmin=(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY)?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}):null;
function sendFile(res,file){res.sendFile(path.join(__dirname,"public",file))}
app.get("/",(_,res)=>sendFile(res,"landing.html")); app.get("/dashboard-demo",(_,res)=>sendFile(res,"dashboard-demo.html")); app.get("/login",(_,res)=>sendFile(res,"login.html")); app.get("/signup",(_,res)=>sendFile(res,"signup.html")); app.get("/dashboard",(_,res)=>sendFile(res,"dashboard.html")); app.get("/demo",(_,res)=>sendFile(res,"dashboard-demo.html")); app.get("/privacy",(_,res)=>sendFile(res,"privacy.html")); app.get("/terms",(_,res)=>sendFile(res,"terms.html")); app.get("/data-deletion",(_,res)=>sendFile(res,"data-deletion.html"));
app.get("/api/public-config",(_,res)=>res.json({supabaseUrl:process.env.SUPABASE_URL||"",supabaseAnonKey:process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_PUBLISHABLE_KEY||""}));
async function getUserFromRequest(req){const a=req.headers.authorization||"";const t=a.startsWith("Bearer ")?a.slice(7):null;if(!t||!supabaseAdmin)return null;const {data,error}=await supabaseAdmin.auth.getUser(t);if(error||!data?.user?.id)return null;return data.user}
async function requireUser(req,res){const u=await getUserFromRequest(req);if(!u){res.status(401).json({error:"Not authenticated"});return null}return u}
async function expireTrialsIfNeeded(){if(!supabaseAdmin)return;const{error}=await supabaseAdmin.rpc("expire_trials");if(error)throw error}
async function getUserSubscription(userId){await expireTrialsIfNeeded();const{data,error}=await supabaseAdmin.from("subscriptions").select("status,trial_end_date").eq("user_id",userId).maybeSingle();if(error)throw error;return data}
function getAccessByStatus(status){const full=["trial","active"].includes(status);const readonly=["expired","cancelled"].includes(status);const blocked=["suspended","deleted"].includes(status);return{dashboard:full||readonly,snapshots:full||readonly,insightHistory:full||readonly,connect:full,manualRefresh:full,dailySync:full,export:full,aiInsights:full,blocked}}
async function requireAccess(req,res,userId,capability){const sub=await getUserSubscription(userId);const access=getAccessByStatus(sub?.status);if(access.blocked||!access[capability]){res.status(403).json({error:"Subscription inactive",status:sub?.status||null});return null}return{sub,access}}
async function requireConnectAccessForOAuth(req,res){const userId=req.query.user_id;if(!userId){res.redirect("/dashboard?error=missing_user_id");return null}const sub=await getUserSubscription(userId);const access=getAccessByStatus(sub?.status);if(access.blocked||!access.connect){res.redirect(`/dashboard?subscription_inactive=1&status=${encodeURIComponent(sub?.status||"")}`);return null}return{userId,sub,access}}
function parseExpiry(s){return s?new Date(Date.now()+Number(s)*1000).toISOString():null}
async function saveConnection(userId,platform,payload){
  if(!supabaseAdmin||!userId)throw new Error("Supabase not configured or user missing");
  const {data:existing,error:existingError}=await supabaseAdmin
    .from("platform_connections")
    .select("account_id,account_name,metadata,refresh_token,token_expires_at")
    .eq("user_id",userId)
    .eq("platform",platform)
    .maybeSingle();
  if(existingError)throw new Error(existingError.message);
  const row={
    user_id:userId,
    platform,
    access_token:payload.accessToken||null,
    refresh_token:payload.refreshToken!==undefined?payload.refreshToken:(existing?.refresh_token||null),
    token_expires_at:payload.tokenExpiresAt!==undefined?payload.tokenExpiresAt:(existing?.token_expires_at||null),
    account_id:payload.accountId!==undefined?payload.accountId:(existing?.account_id||null),
    account_name:payload.accountName!==undefined?payload.accountName:(existing?.account_name||null),
    metadata:{...(existing?.metadata||{}),...(payload.metadata||{})},
    connected:true,
    updated_at:new Date().toISOString()
  };
  const {error}=await supabaseAdmin.from("platform_connections").upsert(row,{onConflict:"user_id,platform"});
  if(error)throw new Error(error.message)
}
async function getConnection(userId,platform){if(!supabaseAdmin||!userId)return null;const {data,error}=await supabaseAdmin.from("platform_connections").select("*").eq("user_id",userId).eq("platform",platform).eq("connected",true).maybeSingle();if(error)throw new Error(error.message);return data}
async function connectionStatus(userId,platform){const r=await getConnection(userId,platform).catch(()=>null);return{connected:Boolean(r&&(r.access_token||r.refresh_token)),source:r?"database":"none",updatedAt:r?.updated_at||null}}
async function requireConnection(req,res,platform){const user=await requireUser(req,res);if(!user)return null;const sub=await getSubscriptionForLifecycle(user.id);const access=getLifecycleAccess(sub?.status);if(access.blocked){res.status(403).json({error:"Account access blocked",status:access.status});return null}const conn=await getConnection(user.id,platform);if(!conn){res.status(404).json({error:`${platform} not connected`});return null}return{user,conn}}

// ===== PHASE 1 CONSTITUTION PACK HELPERS =====
const PHASE1_PLATFORM_LIMITS={meta:3,google:3,klaviyo:3,tiktok:3};
const PHASE1_REPORTABLE_ACCOUNT_TYPES={
  meta:"meta_ads_account",
  google:"google_ads_customer_account",
  tiktok:"tiktok_advertiser_account",
  klaviyo:"klaviyo_account"
};
function phase1ReportableAccountType(platform){return PHASE1_REPORTABLE_ACCOUNT_TYPES[platform]||`${platform}_platform_account`}
function normalizePlatformAccountId(value){return String(value||"").trim()}
function activeOwnershipStatuses(){return ["connected","active"]}

const TIME_ENGINE_VERSION="v1";
const FX_ENGINE_VERSION="v1";
const FX_PROVIDER="snapshot_static_v1";
const DEFAULT_REPORTING_CURRENCY="TRY";

function normalizeCurrency(value){
  const s=String(value||"").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s)?s:null;
}

function resolveFxRate(sourceCurrency,targetCurrency){
  const source=normalizeCurrency(sourceCurrency)||normalizeCurrency(targetCurrency)||DEFAULT_REPORTING_CURRENCY;
  const target=normalizeCurrency(targetCurrency)||source;
  if(source===target){
    return {
      fx_rate:1,
      fx_provider:FX_PROVIDER,
      fx_rate_timestamp:new Date().toISOString(),
      fx_source_currency:source,
      fx_target_currency:target,
      fx_engine_version:FX_ENGINE_VERSION
    };
  }
  const err=new Error(`FX rate missing for ${source}->${target}`);
  err.status=422;
  err.stage="fx";
  throw err;
}

function convertMoney(value,fxRate){
  const n=Number(value||0);
  const rate=Number(fxRate||1);
  return Number.isFinite(n)&&Number.isFinite(rate)?n*rate:0;
}

function cloneJson(value){
  return JSON.parse(JSON.stringify(value||{}));
}

function applyFxToSnapshotPayload(snapshot,fx){
  const fxRate=Number(fx.fx_rate||1);
  const converted=cloneJson(snapshot);

  converted.account_currency=fx.fx_target_currency||converted.account_currency||null;

  if(converted.kpis){
    converted.kpis.spend=convertMoney(converted.kpis.spend,fxRate);
    converted.kpis.revenue=convertMoney(converted.kpis.revenue,fxRate);
    converted.kpis.sales=convertMoney(converted.kpis.sales,fxRate);
    converted.kpis.cpc=converted.kpis.clicks>0?converted.kpis.spend/converted.kpis.clicks:null;
    converted.kpis.roas=converted.kpis.spend>0?converted.kpis.revenue/converted.kpis.spend:null;
  }

  if(converted.click_journey){
    converted.click_journey.real_cpc=converted.click_journey.landing_page_views>0?converted.kpis.spend/converted.click_journey.landing_page_views:null;
  }

  const rows=converted.performance_summary?.rows;
  if(Array.isArray(rows)){
    for(const row of rows){
      row.currency=converted.account_currency;
      row.spend=convertMoney(row.spend,fxRate);
      row.sales=convertMoney(row.sales,fxRate);
      row.revenue=convertMoney(row.revenue,fxRate);
      row.cpc=Number(row.clicks||0)>0?row.spend/Number(row.clicks||0):null;
      row.roas=Number(row.spend||0)>0?Number(row.revenue||0)/Number(row.spend||0):null;
      if(row.raw&&typeof row.raw==="object"){
        row.raw.fx_applied={
          fx_rate:fx.fx_rate,
          fx_provider:fx.fx_provider,
          fx_rate_timestamp:fx.fx_rate_timestamp,
          fx_source_currency:fx.fx_source_currency,
          fx_target_currency:fx.fx_target_currency,
          fx_engine_version:fx.fx_engine_version
        };
      }
    }
  }

  return converted;
}

const AUTOMATION_PLATFORM_HOURS=[0,4,8,12,16,20];
const DEFAULT_PLATFORM_TIMEZONE="UTC";
const DEFAULT_DATA_MATURITY_WINDOW_HOURS={meta:3,google:3,tiktok:3,klaviyo:3,pinterest:3};

function validTimeZone(tz){
  try{
    if(!tz)return false;
    new Intl.DateTimeFormat("en-US",{timeZone:tz}).format(new Date());
    return true;
  }catch{
    return false;
  }
}

function normalizeTimeZone(tz){
  return validTimeZone(tz)?tz:DEFAULT_PLATFORM_TIMEZONE;
}

function timePartsInZone(date=new Date(),timeZone=DEFAULT_PLATFORM_TIMEZONE){
  const tz=normalizeTimeZone(timeZone);
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:tz,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false
  }).formatToParts(date);
  const get=type=>parts.find(p=>p.type===type)?.value;
  let hour=Number(get("hour")||0);
  if(hour===24)hour=0;
  const year=get("year");
  const month=get("month");
  const day=get("day");
  const minute=get("minute");
  const second=get("second");
  return {
    timeZone:tz,
    date:`${year}-${month}-${day}`,
    hour,
    minute:Number(minute||0),
    second:Number(second||0),
    text:`${year}-${month}-${day} ${String(hour).padStart(2,"0")}:${minute}:${second}`
  };
}

function resolveAdminTimeSync(date=new Date(),platformTimeZone=DEFAULT_PLATFORM_TIMEZONE){
  const serverTimeUtc=date.toISOString();
  const istanbul=timePartsInZone(date,"Europe/Istanbul");
  const platform=timePartsInZone(date,platformTimeZone);
  return {
    server_time_utc:serverTimeUtc,
    istanbul_time:istanbul.text,
    platform_account_time:platform.text,
    platform_account_timezone:platform.timeZone,
    platform_business_date:platform.date,
    platform_business_hour:platform.hour
  };
}

function dataMaturityWindowHours(platform){
  return DEFAULT_DATA_MATURITY_WINDOW_HOURS[platform]??3;
}

async function getPlatformAccountTimezone(userId,platform,platformAccountId,conn=null,ownership=null){
  const normalized=normalizePlatformAccountId(platformAccountId);
  let candidates=[
    conn?.metadata?.timezone_name,
    conn?.metadata?.timezone,
    conn?.metadata?.platform_account_timezone,
    conn?.metadata?.account_timezone,
    ownership?.metadata?.timezone_name,
    ownership?.metadata?.timezone,
    ownership?.metadata?.platform_account_timezone
  ];

  if(supabaseAdmin&&userId&&normalized){
    const {data,error}=await supabaseAdmin
      .from("platform_ad_accounts")
      .select("timezone,metadata")
      .eq("user_id",userId)
      .eq("platform",platform)
      .eq("platform_account_id",normalized)
      .maybeSingle();
    if(!error&&data){
      candidates=[
        data.timezone,
        data.metadata?.timezone_name,
        data.metadata?.timezone,
        ...candidates
      ];
    }
  }

  const found=candidates.find(validTimeZone);
  return normalizeTimeZone(found);
}


async function getUserAccountCurrency(userId){
  const {data,error}=await supabaseAdmin.from("users").select("account_currency").eq("id",userId).maybeSingle();
  if(error)throw error;
  return normalizeCurrency(data?.account_currency)||DEFAULT_REPORTING_CURRENCY;
}
async function getOwnership(platform,platformAccountId){
  const id=normalizePlatformAccountId(platformAccountId);
  if(!id)return null;
  const {data,error}=await supabaseAdmin
    .from("platform_account_ownerships")
    .select("*")
    .eq("platform",platform)
    .eq("platform_account_id",id)
    .maybeSingle();
  if(error)throw error;
  return data;
}
async function countActiveOwnerships(userId,platform){
  const {count,error}=await supabaseAdmin
    .from("platform_account_ownerships")
    .select("id",{count:"exact",head:true})
    .eq("owner_user_id",userId)
    .eq("platform",platform)
    .eq("account_type",phase1ReportableAccountType(platform))
    .in("status",activeOwnershipStatuses());
  if(error)throw error;
  return count||0;
}
async function ensurePlatformOwnership(userId,platform,account){
  if(!supabaseAdmin||!userId)throw new Error("Supabase not configured or user missing");
  const platformAccountId=normalizePlatformAccountId(account.platform_account_id||account.id||account.customerId||account.account_id);
  if(!platformAccountId)throw new Error("Platform account id is required for ownership");
  const existing=await getOwnership(platform,platformAccountId);
  const now=new Date().toISOString();
  if(existing&&existing.owner_user_id!==userId&&activeOwnershipStatuses().includes(existing.status)){
    const err=new Error("Platform account already owned by another user");
    err.status=409;
    throw err;
  }
  if(!existing){
    const limit=PHASE1_PLATFORM_LIMITS[platform]||3;
    const activeCount=await countActiveOwnerships(userId,platform);
    if(activeCount>=limit){
      const err=new Error(`Connected reportable platform account limit reached for ${platform}`);
      err.status=403;
      throw err;
    }
    const {data,error}=await supabaseAdmin
      .from("platform_account_ownerships")
      .insert({
        owner_user_id:userId,
        platform,
        platform_account_id:platformAccountId,
        platform_account_name:account.account_name||account.name||account.descriptiveName||null,
        account_type:phase1ReportableAccountType(platform),
        base_currency:account.currency||account.currency_code||null,
        status:"active",
        connected_at:now,
        updated_at:now,
        metadata:account
      })
      .select("*")
      .maybeSingle();
    if(error)throw error;
    return data;
  }
  const {data,error}=await supabaseAdmin
    .from("platform_account_ownerships")
    .update({
      owner_user_id:userId,
      platform_account_name:account.account_name||account.name||account.descriptiveName||existing.platform_account_name||null,
      account_type:phase1ReportableAccountType(platform),
      base_currency:account.currency||account.currency_code||existing.base_currency||null,
      status:"active",
      connected_at:existing.connected_at||now,
      disconnected_at:null,
      updated_at:now,
      metadata:{...(existing.metadata||{}),...account}
    })
    .eq("id",existing.id)
    .select("*")
    .maybeSingle();
  if(error)throw error;
  return data;
}
async function requireActiveOwnership(userId,platform,platformAccountId){
  const ownership=await getOwnership(platform,platformAccountId);
  if(!ownership||ownership.owner_user_id!==userId||!activeOwnershipStatuses().includes(ownership.status)){
    const err=new Error("Platform account ownership is not active");
    err.status=403;
    throw err;
  }
  return ownership;
}
async function disconnectPlatformLifecycle(userId,platform){
  const now=new Date().toISOString();
  const {error:connError}=await supabaseAdmin
    .from("platform_connections")
    .update({connected:false,updated_at:now})
    .eq("user_id",userId)
    .eq("platform",platform);
  if(connError)throw connError;

  const {error:ownershipError}=await supabaseAdmin
    .from("platform_account_ownerships")
    .update({status:"disconnected",disconnected_at:now,updated_at:now})
    .eq("owner_user_id",userId)
    .eq("platform",platform)
    .in("status",activeOwnershipStatuses());
  if(ownershipError)throw ownershipError;

  await supabaseAdmin
    .from("snapshot_schedules")
    .update({active:false,updated_at:now})
    .eq("user_id",userId)
    .eq("platform",platform);

  await supabaseAdmin
    .from("snapshot_jobs")
    .update({status:"failed",error_message:"Stopped by disconnect",finished_at:now,updated_at:now})
    .eq("user_id",userId)
    .eq("platform",platform)
    .in("status",["queued","running"]);

  return {ok:true,platform,connected:false,ownership:"disconnected",snapshot_generation:"stopped"};
}
async function createRefreshJob(userId,platform,platformAccountId,metadata={}){
  const existing=await supabaseAdmin
    .from("snapshot_jobs")
    .select("id,status")
    .eq("user_id",userId)
    .eq("platform",platform)
    .eq("platform_account_id",platformAccountId)
    .in("status",["queued","running"])
    .limit(1)
    .maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data){
    const err=new Error("Refresh job already queued or running for this platform account");
    err.status=409;
    err.job=existing.data;
    throw err;
  }
  const {data,error}=await supabaseAdmin
    .from("snapshot_jobs")
    .insert({user_id:userId,platform,platform_account_id:platformAccountId,status:"queued",metadata,created_at:new Date().toISOString(),updated_at:new Date().toISOString()})
    .select("*")
    .maybeSingle();
  if(error)throw error;
  return data;
}
async function setRefreshJobStatus(jobId,status,extra={}){
  const now=new Date().toISOString();
  const patch={status,updated_at:now,...extra};
  if(status==="running")patch.started_at=now;
  if(["completed","failed"].includes(status))patch.finished_at=now;
  const {data,error}=await supabaseAdmin.from("snapshot_jobs").update(patch).eq("id",jobId).select("*").maybeSingle();
  if(error)throw error;
  return data;
}
// ===== END PHASE 1 CONSTITUTION PACK HELPERS =====
function googleOAuthClient(){if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET||!process.env.GOOGLE_REDIRECT_URI)throw new Error("Missing Google OAuth env");return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI)}
async function getFreshGoogleAccessToken(userId){const conn=await getConnection(userId,"google");if(!conn)throw new Error("Google not connected");const exp=conn.token_expires_at?new Date(conn.token_expires_at).getTime():0;if(conn.access_token&&exp&&exp>Date.now()+120000)return conn.access_token;if(!conn.refresh_token){if(conn.access_token)return conn.access_token;throw new Error("Google refresh token missing. Please reconnect Google.")}const client=googleOAuthClient();client.setCredentials({refresh_token:conn.refresh_token});const {credentials}=await client.refreshAccessToken();const token=credentials.access_token;const expiry=credentials.expiry_date||(Date.now()+3600*1000);await saveConnection(userId,"google",{accessToken:token,refreshToken:conn.refresh_token,tokenExpiresAt:new Date(expiry).toISOString(),metadata:{...(conn.metadata||{}),refreshedAt:new Date().toISOString(),expiryDate:expiry}});return token}
app.get("/auth/meta",async(req,res)=>{try{const accessCheck=await requireConnectAccessForOAuth(req,res);if(!accessCheck)return;const userId=accessCheck.userId;if(!process.env.META_APP_ID||!process.env.META_REDIRECT_URI)throw new Error("Missing Meta env");const state=Math.random().toString(36).slice(2);req.session.metaOAuthState=state;req.session.oauthUserId=userId;const p=new URLSearchParams({client_id:process.env.META_APP_ID,redirect_uri:process.env.META_REDIRECT_URI,state,response_type:"code",scope:"ads_read"});res.redirect(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${p}`)}catch(e){res.status(500).send(e.message)}});
app.get("/auth/meta/callback",async(req,res)=>{try{const{code,state,error,error_description}=req.query;if(error)return res.redirect(`/dashboard?meta_error=${encodeURIComponent(error_description||error)}`);if(!code)return res.redirect("/dashboard?meta_error=missing_code");if(!state||state!==req.session.metaOAuthState)return res.redirect("/dashboard?meta_error=invalid_state");const userId=req.session.oauthUserId;if(!userId)return res.redirect("/dashboard?meta_error=missing_user_id");const url=new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);url.searchParams.set("client_id",process.env.META_APP_ID);url.searchParams.set("redirect_uri",process.env.META_REDIRECT_URI);url.searchParams.set("client_secret",process.env.META_APP_SECRET);url.searchParams.set("code",code);const r=await fetch(url);const data=await r.json();if(!r.ok||!data.access_token)throw new Error(data.error?.message||"Meta token exchange failed");await saveConnection(userId,"meta",{accessToken:data.access_token,tokenExpiresAt:parseExpiry(data.expires_in),metadata:{expiresIn:data.expires_in||null}});req.session.metaOAuthState=null;res.redirect("/dashboard?meta_connected=1")}catch(e){res.redirect(`/dashboard?meta_error=${encodeURIComponent(e.message)}`)}});
app.get("/auth/google",async(req,res)=>{try{const accessCheck=await requireConnectAccessForOAuth(req,res);if(!accessCheck)return;const userId=accessCheck.userId;const state=Math.random().toString(36).slice(2);req.session.googleOAuthState=state;req.session.oauthUserId=userId;const url=googleOAuthClient().generateAuthUrl({access_type:"offline",prompt:"consent",state,scope:["https://www.googleapis.com/auth/adwords"]});res.redirect(url)}catch(e){res.status(500).send(e.message)}});
app.get("/auth/google/callback",async(req,res)=>{try{const{code,state,error}=req.query;if(error)return res.redirect(`/dashboard?google_error=${encodeURIComponent(error)}`);if(!code)return res.redirect("/dashboard?google_error=missing_code");if(!state||state!==req.session.googleOAuthState)return res.redirect("/dashboard?google_error=invalid_state");const userId=req.session.oauthUserId;if(!userId)return res.redirect("/dashboard?google_error=missing_user_id");const client=googleOAuthClient();const{tokens}=await client.getToken(code);await saveConnection(userId,"google",{accessToken:tokens.access_token,refreshToken:tokens.refresh_token||null,tokenExpiresAt:tokens.expiry_date?new Date(tokens.expiry_date).toISOString():null,metadata:{scope:tokens.scope||null,expiryDate:tokens.expiry_date||null,tokenType:tokens.token_type||null}});req.session.googleOAuthState=null;res.redirect("/dashboard?google_connected=1")}catch(e){res.redirect(`/dashboard?google_error=${encodeURIComponent(e.message)}`)}});
function pinterestBasic(){return Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString("base64")}
app.get("/auth/pinterest",async(req,res)=>{try{const accessCheck=await requireConnectAccessForOAuth(req,res);if(!accessCheck)return;const userId=accessCheck.userId;if(!process.env.PINTEREST_CLIENT_ID||!process.env.PINTEREST_REDIRECT_URI)throw new Error("Missing Pinterest env");const state=Math.random().toString(36).slice(2);req.session.pinterestOAuthState=state;req.session.oauthUserId=userId;const p=new URLSearchParams({response_type:"code",client_id:process.env.PINTEREST_CLIENT_ID,redirect_uri:process.env.PINTEREST_REDIRECT_URI,scope:"ads:read",state});res.redirect(`https://www.pinterest.com/oauth/?${p}`)}catch(e){res.status(500).send(e.message)}});
app.get("/auth/pinterest/callback",async(req,res)=>{try{const{code,state,error,error_description}=req.query;if(error)return res.redirect(`/dashboard?pinterest_error=${encodeURIComponent(error_description||error)}`);if(!code)return res.redirect("/dashboard?pinterest_error=missing_code");if(!state||state!==req.session.pinterestOAuthState)return res.redirect("/dashboard?pinterest_error=invalid_state");const userId=req.session.oauthUserId;if(!userId)return res.redirect("/dashboard?pinterest_error=missing_user_id");const body=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:process.env.PINTEREST_REDIRECT_URI});const r=await fetch(`${PINTEREST_API_BASE}/oauth/token`,{method:"POST",headers:{Authorization:`Basic ${pinterestBasic()}`,"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});const data=await r.json();if(!r.ok||!data.access_token)throw new Error(data.message||data.error_description||data.error||"Pinterest token exchange failed");await saveConnection(userId,"pinterest",{accessToken:data.access_token,refreshToken:data.refresh_token||null,tokenExpiresAt:parseExpiry(data.expires_in),metadata:{scope:data.scope||null,expiresIn:data.expires_in||null}});req.session.pinterestOAuthState=null;res.redirect("/dashboard?pinterest_connected=1")}catch(e){res.redirect(`/dashboard?pinterest_error=${encodeURIComponent(e.message)}`)}});

function base64Url(input){return Buffer.from(input).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function klaviyoBasic(){return Buffer.from(`${process.env.KLAVIYO_CLIENT_ID}:${process.env.KLAVIYO_CLIENT_SECRET}`).toString("base64")}
function klaviyoScopes(){return process.env.KLAVIYO_SCOPES||"accounts:read campaigns:read events:read metrics:read conversations:read"}
function klaviyoDateWindow(range,startDate,endDate){
  const end=endDate?new Date(`${endDate}T23:59:59Z`):new Date();
  const start=startDate?new Date(`${startDate}T00:00:00Z`):new Date(end);
  if(!startDate){
    if(range==="today"){}
    else if(range==="yesterday"){start.setDate(start.getDate()-1);end.setDate(end.getDate()-1)}
    else if(range==="last_30d")start.setDate(start.getDate()-29);
    else start.setDate(start.getDate()-6);
  }
  const iso=d=>d.toISOString();
  const dayCount=Math.max(1,Math.ceil((end-start)/(24*60*60*1000))+1);
  return{start:iso(start),end:iso(end),selected_day_count:dayCount}
}
function safeNumber(v){return v===null||v===undefined||v===""?null:Number(v)}
function deepFindNumber(obj,keys){
  if(!obj||typeof obj!=="object")return null;
  for(const k of keys){if(obj[k]!==undefined&&obj[k]!==null&&obj[k]!==""&&!Number.isNaN(Number(obj[k])))return Number(obj[k])}
  for(const v of Object.values(obj)){if(v&&typeof v==="object"){const found=deepFindNumber(v,keys);if(found!==null)return found}}
  return null
}
async function klaviyoFetch(conn,endpoint,options={}){
  const r=await fetch(`${KLAVIYO_API_BASE}${endpoint}`,{...options,headers:{Authorization:`Bearer ${conn.access_token}`,Accept:"application/json",Revision:process.env.KLAVIYO_REVISION||"2024-10-15","Content-Type":"application/json",...(options.headers||{})}});
  const text=await r.text();let data;try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok)throw new Error(data.errors?.[0]?.detail||data.errors?.[0]?.title||data.message||text||`Klaviyo API error ${r.status}`);
  return data
}
async function getKlaviyoMetricId(conn,names){
  const data=await klaviyoFetch(conn,"/api/metrics/");
  const list=Array.isArray(data.data)?data.data:[];
  const wanted=names.map(x=>String(x).toLowerCase());
  const found=list.find(m=>wanted.includes(String(m.attributes?.name||m.name||"").toLowerCase()));
  return found?.id||null
}
function klaviyoCampaignName(c){return c.attributes?.name||c.name||c.attributes?.campaign_name||null}
function klaviyoCampaignStatus(c){return c.attributes?.status||c.status||null}
function klaviyoCampaignSendTime(c){return c.attributes?.send_time||c.attributes?.sendTime||c.send_time||null}
function normalizeKlaviyoInsight({campaign,report,settings,window,extraEvents={}}){
  const attr=report?.attributes||report||{};
  const stats=attr.statistics||attr.stats||attr;
  const estimatedMonthlySpend=Number(settings.estimatedMonthlySpend||0);
  const estimatedPeriodSpend=(estimatedMonthlySpend/30)*window.selected_day_count;
  const spend=estimatedPeriodSpend||0;
  const delivered=deepFindNumber(stats,["delivered","emails_delivered","DELIVERED"])??0;
  const opens=deepFindNumber(stats,["opens","open","opened","OPENED_EMAIL"])??null;
  const clicks=deepFindNumber(stats,["clicks","click","CLICKED_EMAIL"])??0;
  const clickRate=deepFindNumber(stats,["click_rate","clickRate"])??(delivered?clicks/delivered:null);
  const sales=deepFindNumber(stats,["conversion_value","conversions_value","revenue","sales"])??0;
  const purchaseCount=deepFindNumber(stats,["conversions","placed_order","purchase_count"])??0;
  const addToCart=extraEvents.add_to_cart??null;
  const checkout=extraEvents.checkout_started??null;
  const siteVisit=extraEvents.site_visited??null;
  const abandoned=checkout!==null?Math.max((checkout||0)-(purchaseCount||0),0):null;
  const trafficScore=siteVisit&&clicks?(siteVisit/clicks)*100:null;
  return{
    platform:"Klaviyo",
    level:"campaign",
    campaign_id:campaign?.id||attr.campaign_id||null,
    campaign_name:klaviyoCampaignName(campaign)||attr.campaign_name||null,
    campaign_status:klaviyoCampaignStatus(campaign)||null,
    send_time:klaviyoCampaignSendTime(campaign)||null,
    currency:settings.spendCurrency||null,
    impressions:delivered,
    emails_delivered:delivered,
    clicks,
    ctr:clickRate!==null?Number(clickRate)*100:null,
    cpc:clicks?spend/clicks:null,
    spend,
    estimated_monthly_spend:estimatedMonthlySpend,
    estimated_period_spend:spend,
    selected_day_count:window.selected_day_count,
    sales,
    revenue:sales,
    roas:spend>0?sales/spend:null,
    acos:sales>0?(spend/sales)*100:null,
    cvr:clicks?purchaseCount/clicks*100:null,
    email_open:opens,
    opened_email:opens,
    link_clicks:clicks,
    site_visit:siteVisit,
    landing_page_views:siteVisit,
    traffic_score:trafficScore,
    real_cpc:siteVisit?spend/siteVisit:null,
    add_to_cart:addToCart,
    checkout,
    purchase:purchaseCount,
    purchases:purchaseCount,
    purchase_count:purchaseCount,
    abandoned,
    raw:{campaign,report,extraEvents}
  }
}
app.get("/auth/klaviyo",async(req,res)=>{try{const accessCheck=await requireConnectAccessForOAuth(req,res);if(!accessCheck)return;const userId=accessCheck.userId;if(!process.env.KLAVIYO_CLIENT_ID||!process.env.KLAVIYO_CLIENT_SECRET||!process.env.KLAVIYO_REDIRECT_URI)throw new Error("Missing Klaviyo env");const state=Math.random().toString(36).slice(2);const codeVerifier=base64Url(crypto.randomBytes(64));const codeChallenge=base64Url(crypto.createHash("sha256").update(codeVerifier).digest());req.session.klaviyoOAuthState=state;req.session.klaviyoCodeVerifier=codeVerifier;req.session.oauthUserId=userId;const p=new URLSearchParams({response_type:"code",client_id:process.env.KLAVIYO_CLIENT_ID,redirect_uri:process.env.KLAVIYO_REDIRECT_URI,scope:klaviyoScopes(),state,code_challenge_method:"S256",code_challenge:codeChallenge});res.redirect(`${KLAVIYO_WWW_BASE}/oauth/authorize?${p}`)}catch(e){res.status(500).send(e.message)}});
app.get("/auth/klaviyo/callback",async(req,res)=>{try{const{code,state,error,error_description}=req.query;if(error)return res.redirect(`/dashboard?klaviyo_error=${encodeURIComponent(error_description||error)}`);if(!code)return res.redirect("/dashboard?klaviyo_error=missing_code");if(!state||state!==req.session.klaviyoOAuthState)return res.redirect("/dashboard?klaviyo_error=invalid_state");const userId=req.session.oauthUserId;if(!userId)return res.redirect("/dashboard?klaviyo_error=missing_user_id");const verifier=req.session.klaviyoCodeVerifier;if(!verifier)return res.redirect("/dashboard?klaviyo_error=missing_code_verifier");const body=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:process.env.KLAVIYO_REDIRECT_URI,code_verifier:verifier});const r=await fetch(`${KLAVIYO_API_BASE}/oauth/token`,{method:"POST",headers:{Authorization:`Basic ${klaviyoBasic()}`,"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});const data=await r.json().catch(()=>({}));if(!r.ok||!data.access_token)throw new Error(data.error_description||data.error||data.message||"Klaviyo token exchange failed");await saveConnection(userId,"klaviyo",{accessToken:data.access_token,refreshToken:data.refresh_token||null,tokenExpiresAt:parseExpiry(data.expires_in),metadata:{scope:data.scope||klaviyoScopes(),tokenType:data.token_type||null,expiresIn:data.expires_in||null}});req.session.klaviyoOAuthState=null;req.session.klaviyoCodeVerifier=null;res.redirect("/dashboard?klaviyo_connected=1")}catch(e){res.redirect(`/dashboard?klaviyo_error=${encodeURIComponent(e.message)}`)}});
app.get("/api/klaviyo/status",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const conn=await getConnection(user.id,"klaviyo");res.json({connected:Boolean(conn&&(conn.access_token||conn.refresh_token)),setupRequired:Boolean(conn?.metadata?.requiresSetup),estimatedMonthlySpend:conn?.metadata?.estimatedMonthlySpend||null,spendCurrency:conn?.metadata?.spendCurrency||null,updatedAt:conn?.updated_at||null})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/klaviyo/settings",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const conn=await getConnection(user.id,"klaviyo");if(!conn)return res.status(404).json({error:"klaviyo not connected"});const estimatedMonthlySpend=Number(req.body.estimatedMonthlySpend);const spendCurrency=String(req.body.spendCurrency||"").toUpperCase();if(!estimatedMonthlySpend||estimatedMonthlySpend<=0)return res.status(400).json({error:"estimatedMonthlySpend is required"});if(!["USD","TRY","EUR"].includes(spendCurrency))return res.status(400).json({error:"spendCurrency must be USD, TRY or EUR"});const metadata={...(conn.metadata||{}),estimatedMonthlySpend,spendCurrency,requiresSetup:false,setupCompletedAt:new Date().toISOString()};const {error}=await supabaseAdmin.from("platform_connections").update({metadata,updated_at:new Date().toISOString()}).eq("user_id",user.id).eq("platform","klaviyo");if(error)throw error;res.json({ok:true,platform:"klaviyo",estimatedMonthlySpend,spendCurrency,setupRequired:false})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/klaviyo/campaigns",async(req,res)=>{try{const result=await requireConnection(req,res,"klaviyo");if(!result)return;const{conn}=result;const range=String(req.query.date_range||req.query.dateRange||"last_7d");const w=klaviyoDateWindow(range,req.query.start_date,req.query.end_date);const channel=String(req.query.channel||"email");const filter=`equals(messages.channel,\'${channel}\'),greater-or-equal(scheduled_at,${w.start}),less-or-equal(scheduled_at,${w.end})`;const data=await klaviyoFetch(conn,`/api/campaigns/?filter=${encodeURIComponent(filter)}`);res.json(data)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/klaviyo/insights",async(req,res)=>{try{const result=await requireConnection(req,res,"klaviyo");if(!result)return;const{conn}=result;if(conn.metadata?.requiresSetup)return res.status(400).json({error:"Klaviyo setup required. Please enter estimated monthly spend and currency."});const range=String(req.query.date_range||req.query.dateRange||"last_7d");const w=klaviyoDateWindow(range,req.query.start_date,req.query.end_date);const campaignLimit=Math.min(Number(req.query.limit||25),50);const channel=String(req.query.channel||"email");const filter=`equals(messages.channel,\'${channel}\'),greater-or-equal(scheduled_at,${w.start}),less-or-equal(scheduled_at,${w.end})`;const campaignsData=await klaviyoFetch(conn,`/api/campaigns/?filter=${encodeURIComponent(filter)}`);const campaigns=(campaignsData.data||[]).slice(0,campaignLimit);let placedOrderMetricId=req.query.placedOrderMetricId||process.env.KLAVIYO_PLACED_ORDER_METRIC_ID||null;if(!placedOrderMetricId)placedOrderMetricId=await getKlaviyoMetricId(conn,["Placed Order","Placed order","Order Placed"]);
const rows=[];const errors=[];
for(const campaign of campaigns){
  try{
    let report=null;
    if(placedOrderMetricId){
      const body={data:{type:"campaign-values-report",attributes:{timeframe:{start:w.start,end:w.end},conversion_metric_id:placedOrderMetricId,filter:`equals(campaign_id,"${campaign.id}")`,statistics:["delivered","opens","clicks","click_rate","conversion_value","conversions"]}}};
      report=await klaviyoFetch(conn,"/api/campaign-values-reports/",{method:"POST",body:JSON.stringify(body)});
    }
    rows.push(normalizeKlaviyoInsight({campaign,report,settings:conn.metadata||{},window:w}));
  }catch(err){errors.push({campaign_id:campaign.id,error:err.message});rows.push(normalizeKlaviyoInsight({campaign,report:null,settings:conn.metadata||{},window:w}))}
}
res.json({platform:"Klaviyo",level:"campaign",date_range:range,start:w.start,end:w.end,selected_day_count:w.selected_day_count,rows,rawCount:rows.length,errors,metadata:{campaignCount:campaigns.length,placedOrderMetricId:placedOrderMetricId||null}})
}catch(e){res.status(500).json({error:e.message})}});


// ===== PHASE E.2A META SNAPSHOT WRITE =====
function e2aNumber(value){
  const n=Number(value);
  return Number.isFinite(n)?n:0;
}

function e2aNullableNumber(value){
  if(value===null||value===undefined||value==="")return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

function e2aSum(rows,field){
  return (rows||[]).reduce((total,row)=>total+e2aNumber(row?.[field]),0);
}

function e2aWeightedAverage(rows,valueField,weightField){
  let weighted=0,weight=0;
  for(const row of rows||[]){
    const value=e2aNullableNumber(row?.[valueField]);
    const w=e2aNumber(row?.[weightField]);
    if(value!==null&&w>0){
      weighted+=value*w;
      weight+=w;
    }
  }
  return weight>0?weighted/weight:null;
}

function e2aSnapshotDate(value,timeZone=DEFAULT_PLATFORM_TIMEZONE){
  if(value)return String(value).slice(0,10);
  return timePartsInZone(new Date(),timeZone).date;
}

function e2aBuildMetaSnapshot({snapshotDate,accountCurrency,campaignRows,adsetRows,adRows}){
  const rows=[...(campaignRows||[]),...(adsetRows||[]),...(adRows||[])];
  const aggregateRows=(campaignRows&&campaignRows.length)?campaignRows:rows;

  const spend=e2aSum(aggregateRows,"spend");
  const revenue=e2aSum(aggregateRows,"revenue");
  const sales=revenue;
  const impressions=e2aSum(aggregateRows,"impressions");
  const reach=e2aSum(aggregateRows,"reach");
  const clicks=e2aSum(aggregateRows,"clicks");
  const linkClicks=e2aSum(aggregateRows,"link_clicks");
  const landingPageViews=e2aSum(aggregateRows,"landing_page_views");
  const addToCart=e2aSum(aggregateRows,"add_to_cart");
  const checkout=e2aSum(aggregateRows,"checkout");
  const purchase=e2aSum(aggregateRows,"purchase");
  const abandoned=Math.max(checkout-purchase,0);

  const ctr=clicks>0&&impressions>0?(clicks/impressions)*100:e2aWeightedAverage(aggregateRows,"ctr","impressions");
  const cpc=clicks>0?spend/clicks:e2aWeightedAverage(aggregateRows,"cpc","clicks");
  const roas=spend>0?revenue/spend:null;
  const trafficScore=linkClicks>0?(landingPageViews/linkClicks)*100:null;
  const realCpc=landingPageViews>0?spend/landingPageViews:null;

  const normalizeRow=row=>({
    platform:row.platform||"Meta",
    level:row.level||null,
    campaign_id:row.campaign_id||null,
    campaign_name:row.campaign_name||null,
    adset_id:row.adset_id||null,
    adset_name:row.adset_name||null,
    ad_id:row.ad_id||null,
    ad_name:row.ad_name||null,
    currency:row.currency||accountCurrency||null,
    spend:e2aNumber(row.spend),
    sales:e2aNumber(row.sales??row.revenue),
    revenue:e2aNumber(row.revenue??row.sales),
    impressions:e2aNumber(row.impressions),
    reach:e2aNumber(row.reach),
    clicks:e2aNumber(row.clicks),
    ctr:e2aNullableNumber(row.ctr),
    cpc:e2aNullableNumber(row.cpc),
    roas:e2aNullableNumber(row.roas),
    link_clicks:e2aNumber(row.link_clicks),
    landing_page_views:e2aNumber(row.landing_page_views),
    add_to_cart:e2aNumber(row.add_to_cart),
    checkout:e2aNumber(row.checkout),
    purchase:e2aNumber(row.purchase),
    abandoned:e2aNumber(row.abandoned),
    raw:row.raw||{}
  });

  return {
    snapshot_date:snapshotDate,
    account_currency:accountCurrency||null,
    kpis:{
      spend,
      sales,
      revenue,
      impressions,
      reach,
      clicks,
      ctr,
      cpc,
      roas
    },
    purchase_journey:{
      add_to_cart:addToCart,
      checkout,
      purchase,
      abandoned
    },
    click_journey:{
      ad_clicks:clicks,
      link_clicks:linkClicks,
      landing_page_views:landingPageViews,
      traffic_score:trafficScore,
      real_cpc:realCpc
    },
    performance_summary:{
      rows:rows.map(normalizeRow),
      counts:{
        campaign:(campaignRows||[]).length,
        adset:(adsetRows||[]).length,
        ad:(adRows||[]).length,
        total:rows.length
      }
    }
  };
}

async function e2aFetchMetaInsightsForLevel(conn,adAccountId,level,datePreset,limit){
  const fields=["campaign_id","campaign_name","account_currency","impressions","reach","clicks","ctr","cpc","spend","actions","action_values","cost_per_action_type","conversion_rate_ranking"];
  if(level==="adset")fields.splice(2,0,"adset_id","adset_name");
  if(level==="ad")fields.splice(2,0,"adset_id","adset_name","ad_id","ad_name");

  const data=await metaGraph(`/${adAccountId}/insights`,{
    level,
    date_preset:datePreset,
    fields:fields.join(","),
    limit
  },conn.access_token);

  return (data.data||[]).map(row=>normalizeMetaInsight(row,level));
}

async function resolveMetaRefreshAccount(user,conn,requestedAccountId){
  const requested=normalizePlatformAccountId(requestedAccountId);
  if(requested){
    const existingAdAccount=await supabaseAdmin
      .from("platform_ad_accounts")
      .select("platform_account_id,account_name,currency,metadata")
      .eq("user_id",user.id)
      .eq("platform","meta")
      .eq("platform_account_id",requested)
      .maybeSingle();
    if(existingAdAccount.error)throw existingAdAccount.error;
    const account={
      id:requested,
      platform_account_id:requested,
      name:existingAdAccount.data?.account_name||conn.account_name||requested,
      account_name:existingAdAccount.data?.account_name||conn.account_name||requested,
      currency:existingAdAccount.data?.currency||conn.metadata?.baseCurrency||null,
      ...(existingAdAccount.data?.metadata||{})
    };
    await ensurePlatformOwnership(user.id,"meta",account);
    return {platformAccountId:requested,account};
  }

  const storedId=normalizePlatformAccountId(conn.account_id||conn.metadata?.lastOwnedPlatformAccountId||conn.metadata?.selectedPlatformAccountId);
  if(storedId){
    const account={
      id:storedId,
      platform_account_id:storedId,
      name:conn.account_name||storedId,
      account_name:conn.account_name||storedId,
      currency:conn.metadata?.baseCurrency||null
    };
    await ensurePlatformOwnership(user.id,"meta",account);
    return {platformAccountId:storedId,account};
  }

  const accountsData=await metaGraph("/me/adaccounts",{fields:"id,name,account_status,currency,timezone_name",limit:"100"},conn.access_token);
  const accounts=accountsData.data||[];
  if(!accounts.length){
    const err=new Error("No Meta ad account found for connected user");
    err.status=404;
    throw err;
  }
  const first=accounts[0];
  await upsertAdAccount(user.id,"meta",first);
  return {platformAccountId:normalizePlatformAccountId(first.id),account:first};
}


function resolveSnapshotCapturePeriod(datePreset,snapshotDate,platformTimeZone=DEFAULT_PLATFORM_TIMEZONE,nowDate=new Date()){
  const normalized=String(datePreset||"today").trim().toLowerCase();
  const nowParts=timePartsInZone(nowDate,platformTimeZone);
  const baseDate=snapshotDate?String(snapshotDate).slice(0,10):nowParts.date;

  if(normalized==="last_7d" || normalized==="last_7_days"){
    return {
      datePreset:"last_7d",
      start:addUtcDays(baseDate,-6),
      end:baseDate,
      scope:"recovery_last_7d",
      snapshotClass:"recovery"
    };
  }

  if(normalized==="yesterday"){
    const y=addUtcDays(baseDate,-1);
    return {
      datePreset:"yesterday",
      start:y,
      end:y,
      scope:"yesterday",
      snapshotClass:"primary"
    };
  }

  if(normalized==="day_close"){
    const y=addUtcDays(baseDate,-1);
    return {
      datePreset:"yesterday",
      start:y,
      end:y,
      scope:"final_day_close",
      snapshotClass:"primary"
    };
  }

  return {
    datePreset:"today",
    start:baseDate,
    end:baseDate,
    scope:"today",
    snapshotClass:"primary"
  };
}

function resolveAutoRefreshPolicy({date=new Date(),platformTimeZone=DEFAULT_PLATFORM_TIMEZONE,platform="meta"}={}){
  const sync=resolveAdminTimeSync(date,platformTimeZone);
  const platformParts=timePartsInZone(date,platformTimeZone);
  const hour=sync.platform_business_hour;
  const isAutomationHour=AUTOMATION_PLATFORM_HOURS.includes(hour);
  const maturityHours=dataMaturityWindowHours(platform);
  const isDayCloseHour=hour===maturityHours;
  const isRecoveryHour=hour===4;

  let datePreset="today";
  let captureReason="automation_today";
  let snapshotClass="primary";

  if(isDayCloseHour){
    datePreset="day_close";
    captureReason="day_close";
    snapshotClass="primary";
  }else if(isRecoveryHour){
    datePreset="last_7d";
    captureReason="automation_recovery";
    snapshotClass="recovery";
  }

  return {
    ...sync,
    hour,
    minute:platformParts.minute,
    isAutomationHour,
    automation_hours:AUTOMATION_PLATFORM_HOURS,
    datePreset,
    captureReason,
    snapshotClass,
    data_maturity_window_hours:maturityHours
  };
}


async function writeMetaSnapshotImmutable({user,conn,adAccountId,datePreset="today",snapshotDate,limit="100",sourceJobId=null,captureReason="manual_refresh",platformTimeZone=null,snapshotClass=null,adminTimeSync=null}){
  const platformAccountId=normalizePlatformAccountId(adAccountId);
  const ownership=await requireActiveOwnership(user.id,"meta",platformAccountId);
  const resolvedTimeZone=normalizeTimeZone(platformTimeZone||await getPlatformAccountTimezone(user.id,"meta",platformAccountId,conn,ownership));
  const timeSync=adminTimeSync||resolveAdminTimeSync(new Date(),resolvedTimeZone);
  const effectiveSnapshotDate=e2aSnapshotDate(snapshotDate,resolvedTimeZone);
  const period=resolveSnapshotCapturePeriod(datePreset,effectiveSnapshotDate,resolvedTimeZone,new Date());
  const normalizedDatePreset=period.datePreset;
  const resolvedSnapshotClass=snapshotClass||period.snapshotClass||"primary";

  const campaignRows=await e2aFetchMetaInsightsForLevel(conn,platformAccountId,"campaign",normalizedDatePreset,limit);
  const adsetRows=await e2aFetchMetaInsightsForLevel(conn,platformAccountId,"adset",normalizedDatePreset,limit);
  const adRows=await e2aFetchMetaInsightsForLevel(conn,platformAccountId,"ad",normalizedDatePreset,limit);

  const platformBaseCurrency=
    ownership.base_currency||
    campaignRows.find(r=>r.currency)?.currency||
    adsetRows.find(r=>r.currency)?.currency||
    adRows.find(r=>r.currency)?.currency||
    null;
  const accountCurrency=await getUserAccountCurrency(user.id)||normalizeCurrency(platformBaseCurrency)||DEFAULT_REPORTING_CURRENCY;
  const fx=resolveFxRate(platformBaseCurrency,accountCurrency);

  const rawSnapshot=e2aBuildMetaSnapshot({
    snapshotDate:effectiveSnapshotDate,
    accountCurrency:platformBaseCurrency,
    campaignRows,
    adsetRows,
    adRows
  });

  const snapshot=applyFxToSnapshotPayload(rawSnapshot,fx);

  const existingVersionResult=await supabaseAdmin
    .from("dashboard_snapshots")
    .select("snapshot_version")
    .eq("user_id",user.id)
    .eq("platform","meta")
    .eq("platform_account_id",platformAccountId)
    .eq("snapshot_date",snapshot.snapshot_date)
    .order("snapshot_version",{ascending:false})
    .limit(1)
    .maybeSingle();
  if(existingVersionResult.error)throw existingVersionResult.error;
  const snapshotVersion=Number(existingVersionResult.data?.snapshot_version||0)+1;
  const now=new Date().toISOString();

  const row={
    user_id:user.id,
    platform:"meta",
    platform_account_id:platformAccountId,
    platform_base_currency:platformBaseCurrency,
    snapshot_version:snapshotVersion,
    source_job_id:sourceJobId,
    date_preset:normalizedDatePreset,
    snapshot_period_start:period.start,
    snapshot_period_end:period.end,
    snapshot_scope:period.scope,
    capture_reason:captureReason,
    snapshot_class:resolvedSnapshotClass,
    platform_account_timezone:resolvedTimeZone,
    platform_business_date:timeSync.platform_business_date,
    platform_business_hour:timeSync.platform_business_hour,
    data_maturity_window_hours:dataMaturityWindowHours("meta"),
    server_time_utc:timeSync.server_time_utc,
    istanbul_time:timeSync.istanbul_time,
    platform_account_time:timeSync.platform_account_time,
    time_engine_version:TIME_ENGINE_VERSION,
    fx_rate:fx.fx_rate,
    fx_provider:fx.fx_provider,
    fx_rate_timestamp:fx.fx_rate_timestamp,
    fx_source_currency:fx.fx_source_currency,
    fx_target_currency:fx.fx_target_currency,
    fx_engine_version:fx.fx_engine_version,
    snapshot_date:snapshot.snapshot_date,
    snapshot_created_at:now,
    account_currency:snapshot.account_currency,
    kpis:snapshot.kpis,
    purchase_journey:snapshot.purchase_journey,
    click_journey:snapshot.click_journey,
    performance_summary:snapshot.performance_summary
  };

  const {data,error}=await supabaseAdmin
    .from("dashboard_snapshots")
    .insert(row)
    .select("id,platform,platform_account_id,platform_base_currency,snapshot_version,source_job_id,date_preset,snapshot_period_start,snapshot_period_end,snapshot_scope,capture_reason,snapshot_class,platform_account_timezone,platform_business_date,platform_business_hour,data_maturity_window_hours,server_time_utc,istanbul_time,platform_account_time,time_engine_version,fx_rate,fx_provider,fx_rate_timestamp,fx_source_currency,fx_target_currency,fx_engine_version,snapshot_date,snapshot_created_at,account_currency,kpis,purchase_journey,click_journey,performance_summary")
    .maybeSingle();
  if(error)throw error;

  return {mode:"insert",snapshot:data,row_counts:snapshot.performance_summary.counts};
}

async function handleMetaSnapshotWrite(req,res){
  let job=null;
  let stage="connection";
  try{
    const result=await requireConnection(req,res,"meta");
    if(!result)return;

    const {user,conn}=result;
    const requestedAdAccountId=req.body?.adAccountId||req.body?.ad_account_id||req.query.adAccountId||req.query.ad_account_id;

    stage="ownership";
    const resolved=await resolveMetaRefreshAccount(user,conn,requestedAdAccountId);
    const platformAccountId=normalizePlatformAccountId(resolved.platformAccountId);
    if(!platformAccountId)return res.status(400).json({ok:false,error:"Missing Meta ad account id",stage});

    const platformTimeZone=await getPlatformAccountTimezone(user.id,"meta",platformAccountId,conn,null);
    const adminTimeSync=resolveAdminTimeSync(new Date(),platformTimeZone);
    const datePreset="today";
    const snapshotDate=e2aSnapshotDate(req.body?.snapshot_date||req.query.snapshot_date,platformTimeZone);
    const limit=String(req.body?.limit||req.query.limit||"100");

    stage="job";
    job=await createRefreshJob(user.id,"meta",platformAccountId,{trigger:"manual",datePreset,snapshotDate,limit,captureReason:"manual_refresh",snapshotClass:"primary",...adminTimeSync,timeEngineVersion:TIME_ENGINE_VERSION});
    await setRefreshJobStatus(job.id,"running");

    stage="meta_api";
    const writeResult=await writeMetaSnapshotImmutable({user,conn,adAccountId:platformAccountId,datePreset,snapshotDate,limit,sourceJobId:job.id,captureReason:"manual_refresh",platformTimeZone,adminTimeSync,snapshotClass:"primary"});

    stage="snapshot";
    await setRefreshJobStatus(job.id,"completed",{snapshot_id:writeResult.snapshot?.id||null});

    res.json({
      ok:true,
      platform:"Meta",
      refresh_job:{id:job.id,status:"completed"},
      mode:writeResult.mode,
      snapshot_id:writeResult.snapshot?.id||null,
      snapshot_date:writeResult.snapshot?.snapshot_date||snapshotDate,
      snapshot_version:writeResult.snapshot?.snapshot_version||null,
      snapshot_class:writeResult.snapshot?.snapshot_class||null,
      platform_account_timezone:writeResult.snapshot?.platform_account_timezone||platformTimeZone,
      platform_business_date:writeResult.snapshot?.platform_business_date||null,
      platform_business_hour:writeResult.snapshot?.platform_business_hour??null,
      server_time_utc:writeResult.snapshot?.server_time_utc||adminTimeSync.server_time_utc,
      istanbul_time:writeResult.snapshot?.istanbul_time||adminTimeSync.istanbul_time,
      platform_account_time:writeResult.snapshot?.platform_account_time||adminTimeSync.platform_account_time,
      platform_account_id:writeResult.snapshot?.platform_account_id||platformAccountId,
      platform_base_currency:writeResult.snapshot?.platform_base_currency||null,
      account_currency:writeResult.snapshot?.account_currency||null,
      fx_rate:writeResult.snapshot?.fx_rate??null,
      fx_provider:writeResult.snapshot?.fx_provider||null,
      fx_rate_timestamp:writeResult.snapshot?.fx_rate_timestamp||null,
      fx_source_currency:writeResult.snapshot?.fx_source_currency||null,
      fx_target_currency:writeResult.snapshot?.fx_target_currency||null,
      fx_engine_version:writeResult.snapshot?.fx_engine_version||null,
      row_counts:writeResult.row_counts,
      kpis:writeResult.snapshot?.kpis||{},
      purchase_journey:writeResult.snapshot?.purchase_journey||{},
      click_journey:writeResult.snapshot?.click_journey||{}
    });
  }catch(e){
    if(job?.id)await setRefreshJobStatus(job.id,"failed",{error_message:e.message}).catch(()=>null);
    res.status(e.status||500).json({ok:false,error:e.message,stage,job_id:job?.id||null});
  }
}
app.post("/api/snapshots/meta/write",handleMetaSnapshotWrite);
app.post("/api/refresh/meta",handleMetaSnapshotWrite);

app.get("/api/refresh/status",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    let q=supabaseAdmin.from("snapshot_jobs").select("*").eq("user_id",user.id).order("created_at",{ascending:false}).limit(Number(req.query.limit||10));
    if(req.query.platform)q=q.eq("platform",String(req.query.platform));
    if(req.query.platform_account_id)q=q.eq("platform_account_id",String(req.query.platform_account_id));
    const {data,error}=await q;
    if(error)throw error;
    res.json({ok:true,jobs:data||[]});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

async function runMetaAutoRefreshForSchedule(schedule){
  let job=null;
  const runDate=new Date();
  const limit=String(schedule.metadata?.limit||"100");

  const {data:user,error:userError}=await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id",schedule.user_id)
    .maybeSingle();
  if(userError)throw userError;
  if(!user)throw new Error("Auto refresh user not found");

  const {data:conn,error:connError}=await supabaseAdmin
    .from("platform_connections")
    .select("*")
    .eq("user_id",schedule.user_id)
    .eq("platform","meta")
    .eq("connected",true)
    .maybeSingle();
  if(connError)throw connError;
  if(!conn)throw new Error("Auto refresh Meta connection not found");

  const platformAccountId=normalizePlatformAccountId(schedule.platform_account_id||conn.account_id);
  if(!platformAccountId)throw new Error("Auto refresh missing platform account id");

  const platformTimeZone=await getPlatformAccountTimezone(schedule.user_id,"meta",platformAccountId,conn,null);
  const policy=resolveAutoRefreshPolicy({date:runDate,platformTimeZone,platform:"meta"});
  const snapshotDate=e2aSnapshotDate(null,platformTimeZone);

  if(!policy.isAutomationHour){
    return {
      ok:true,
      skipped:true,
      reason:"not_platform_automation_hour",
      schedule_id:schedule.id,
      platform_account_id:platformAccountId,
      platform_account_timezone:platformTimeZone,
      platform_business_hour:policy.platform_business_hour,
      platform_account_time:policy.platform_account_time,
      server_time_utc:policy.server_time_utc,
      istanbul_time:policy.istanbul_time,
      automation_hours:policy.automation_hours
    };
  }

  job=await createRefreshJob(schedule.user_id,"meta",platformAccountId,{
    trigger:"automation",
    datePreset:policy.datePreset,
    snapshotDate,
    limit,
    captureReason:policy.captureReason,
    snapshotClass:policy.snapshotClass,
    scheduleId:schedule.id,
    platformHour:policy.hour,
    platformBusinessHour:policy.platform_business_hour,
    dataMaturityWindowHours:policy.data_maturity_window_hours,
    server_time_utc:policy.server_time_utc,
    istanbul_time:policy.istanbul_time,
    platform_account_time:policy.platform_account_time,
    platform_account_timezone:policy.platform_account_timezone,
    platform_business_date:policy.platform_business_date,
    timeEngineVersion:TIME_ENGINE_VERSION
  });

  await setRefreshJobStatus(job.id,"running");

  try{
    const writeResult=await writeMetaSnapshotImmutable({
      user,
      conn,
      adAccountId:platformAccountId,
      datePreset:policy.datePreset,
      snapshotDate,
      limit,
      sourceJobId:job.id,
      captureReason:policy.captureReason,
      platformTimeZone,
      adminTimeSync:policy,
      snapshotClass:policy.snapshotClass
    });

    await setRefreshJobStatus(job.id,"completed",{snapshot_id:writeResult.snapshot?.id||null});

    await supabaseAdmin
      .from("snapshot_schedules")
      .update({
        last_run_at:new Date().toISOString(),
        next_run_at:new Date(Date.now()+Number(schedule.interval_minutes||240)*60000).toISOString(),
        updated_at:new Date().toISOString()
      })
      .eq("id",schedule.id);

    return {ok:true,job_id:job.id,snapshot_id:writeResult.snapshot?.id||null,snapshot_version:writeResult.snapshot?.snapshot_version||null,snapshot_class:writeResult.snapshot?.snapshot_class||policy.snapshotClass,date_preset:policy.datePreset,capture_reason:policy.captureReason,platform_account_timezone:platformTimeZone,platform_account_time:policy.platform_account_time,server_time_utc:policy.server_time_utc,istanbul_time:policy.istanbul_time,fx_rate:writeResult.snapshot?.fx_rate??null,fx_provider:writeResult.snapshot?.fx_provider||null,fx_source_currency:writeResult.snapshot?.fx_source_currency||null,fx_target_currency:writeResult.snapshot?.fx_target_currency||null,fx_engine_version:writeResult.snapshot?.fx_engine_version||null};
  }catch(e){
    await setRefreshJobStatus(job.id,"failed",{error_message:e.message}).catch(()=>null);
    throw e;
  }
}

app.get("/api/cron/auto-refresh",async(req,res)=>{
  const startedAt=new Date().toISOString();
  try{
    const {data:schedules,error}=await supabaseAdmin
      .from("snapshot_schedules")
      .select("*")
      .eq("active",true)
      .eq("platform","meta");

    if(error)throw error;

    const results=[];
    for(const schedule of schedules||[]){
      try{
        results.push(await runMetaAutoRefreshForSchedule(schedule));
      }catch(e){
        results.push({ok:false,schedule_id:schedule.id,error:e.message});
      }
    }

    res.json({ok:true,started_at:startedAt,count:results.length,results});
  }catch(e){
    res.status(500).json({ok:false,error:e.message,started_at:startedAt});
  }
});

// ===== END PHASE E.2A META SNAPSHOT WRITE =====
// ===== PHASE E.2C META SNAPSHOT READ =====
function toIsoDateOnly(value){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  const y=d.getUTCFullYear();
  const m=String(d.getUTCMonth()+1).padStart(2,"0");
  const day=String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function addUtcDays(isoDate,days){
  const parts=String(isoDate||"").split("-").map(Number);
  if(parts.length!==3||parts.some(n=>!Number.isFinite(n)))return "";
  const d=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
  d.setUTCDate(d.getUTCDate()+days);
  return toIsoDateOnly(d);
}

function resolveSnapshotDateScope(query,platformTimeZone=DEFAULT_PLATFORM_TIMEZONE){
  const raw=String(query.date_filter||"latest").trim().toLowerCase();
  const dateFilter=raw.replace(/\s+/g,"_");
  const today=timePartsInZone(new Date(),platformTimeZone).date;

  if(dateFilter==="today"){
    return {dateFilter,start:today,end:today};
  }

  if(dateFilter==="yesterday"){
    const yesterday=addUtcDays(today,-1);
    return {dateFilter,start:yesterday,end:yesterday};
  }

  if(dateFilter==="last_7_days"){
    return {dateFilter,start:addUtcDays(today,-6),end:today};
  }

  if(dateFilter==="this_month"){
    return {dateFilter,start:today.slice(0,7)+"-01",end:today};
  }

  if(dateFilter==="custom"){
    const start=String(query.start_date||"").slice(0,10);
    const end=String(query.end_date||"").slice(0,10);
    return {dateFilter,start:start||null,end:end||null};
  }

  return {dateFilter:"latest",start:null,end:null};
}


function normalizeSnapshotForResponse(data){
  if(!data)return null;
  return {
    platform:data.platform||"meta",
    platform_account_id:data.platform_account_id||null,
    platform_base_currency:data.platform_base_currency||null,
    snapshot_version:data.snapshot_version||null,
    source_job_id:data.source_job_id||null,
    date_preset:data.date_preset||null,
    snapshot_period_start:data.snapshot_period_start||null,
    snapshot_period_end:data.snapshot_period_end||null,
    snapshot_scope:data.snapshot_scope||null,
    capture_reason:data.capture_reason||null,
    snapshot_class:data.snapshot_class||null,
    platform_account_timezone:data.platform_account_timezone||null,
    platform_business_date:data.platform_business_date||null,
    platform_business_hour:data.platform_business_hour??null,
    server_time_utc:data.server_time_utc||null,
    istanbul_time:data.istanbul_time||null,
    platform_account_time:data.platform_account_time||null,
    time_engine_version:data.time_engine_version||null,
    fx_rate:data.fx_rate??null,
    fx_provider:data.fx_provider||null,
    fx_rate_timestamp:data.fx_rate_timestamp||null,
    fx_source_currency:data.fx_source_currency||null,
    fx_target_currency:data.fx_target_currency||null,
    fx_engine_version:data.fx_engine_version||null,
    snapshot_date:data.snapshot_date,
    snapshot_created_at:data.snapshot_created_at||data.created_at||null,
    account_currency:data.account_currency,
    kpis:data.kpis||{},
    purchase_journey:data.purchase_journey||{},
    click_journey:data.click_journey||{},
    performance_summary:data.performance_summary||{rows:[],counts:{}}
  };
}

function pickLatestSnapshotPerDay(rows){
  const map=new Map();
  for(const row of rows||[]){
    if(row.snapshot_class==="recovery")continue;
    const key=String(row.snapshot_date||"");
    const current=map.get(key);
    const rowVersion=Number(row.snapshot_version||0);
    const currentVersion=Number(current?.snapshot_version||0);
    const rowCreated=new Date(row.snapshot_created_at||row.created_at||0).getTime();
    const currentCreated=new Date(current?.snapshot_created_at||current?.created_at||0).getTime();

    if(!current || rowVersion>currentVersion || (rowVersion===currentVersion && rowCreated>currentCreated)){
      map.set(key,row);
    }
  }
  return [...map.values()].sort((a,b)=>String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
}

function aggregateSnapshots(rows,scope){
  const daily=pickLatestSnapshotPerDay(rows);
  if(!daily.length)return null;

  const kpis={impressions:0,reach:0,clicks:0,spend:0,sales:0,revenue:0,cpc:null,ctr:null,roas:null};
  const purchase_journey={add_to_cart:0,checkout:0,purchase:0,abandoned:0};
  const click_journey={ad_clicks:0,link_clicks:0,landing_page_views:0,real_cpc:null,traffic_score:null};
  const performanceRows=[];
  const counts={campaign:0,adset:0,ad:0,total:0};

  for(const snap of daily){
    const sK=snap.kpis||{};
    kpis.impressions+=numberOrZero(sK.impressions);
    kpis.reach+=numberOrZero(sK.reach);
    kpis.clicks+=numberOrZero(sK.clicks);
    kpis.spend+=numberOrZero(sK.spend);
    kpis.sales+=numberOrZero(sK.sales);
    kpis.revenue+=numberOrZero(sK.revenue);

    const pj=snap.purchase_journey||{};
    purchase_journey.add_to_cart+=numberOrZero(pj.add_to_cart);
    purchase_journey.checkout+=numberOrZero(pj.checkout);
    purchase_journey.purchase+=numberOrZero(pj.purchase);
    purchase_journey.abandoned+=numberOrZero(pj.abandoned);

    const cj=snap.click_journey||{};
    click_journey.ad_clicks+=numberOrZero(cj.ad_clicks);
    click_journey.link_clicks+=numberOrZero(cj.link_clicks);
    click_journey.landing_page_views+=numberOrZero(cj.landing_page_views);

    const ps=snap.performance_summary||{};
    const rows=Array.isArray(ps.rows)?ps.rows:[];
    performanceRows.push(...rows);
    const c=ps.counts||{};
    counts.campaign+=numberOrZero(c.campaign);
    counts.adset+=numberOrZero(c.adset);
    counts.ad+=numberOrZero(c.ad);
    counts.total+=numberOrZero(c.total||rows.length);
  }

  kpis.cpc=safeDivide(kpis.spend,kpis.clicks);
  kpis.ctr=safeDivide(kpis.clicks*100,kpis.impressions);
  kpis.roas=safeDivide(kpis.revenue,kpis.spend);
  click_journey.real_cpc=safeDivide(kpis.spend,click_journey.landing_page_views);
  click_journey.traffic_score=safeDivide(click_journey.landing_page_views*100,click_journey.ad_clicks);

  const latest=daily[daily.length-1];
  return {
    platform:latest.platform||"meta",
    platform_account_id:latest.platform_account_id||null,
    platform_base_currency:latest.platform_base_currency||null,
    snapshot_version:latest.snapshot_version||null,
    source_job_id:latest.source_job_id||null,
    date_preset:"aggregate",
    snapshot_class:"aggregate_primary",
    snapshot_period_start:scope.start,
    snapshot_period_end:scope.end,
    snapshot_scope:scope.dateFilter,
    capture_reason:"date_filter_aggregate",
    platform_account_timezone:latest.platform_account_timezone||null,
    platform_business_date:latest.platform_business_date||null,
    platform_business_hour:latest.platform_business_hour??null,
    fx_rate:latest.fx_rate??null,
    fx_provider:latest.fx_provider||null,
    fx_rate_timestamp:latest.fx_rate_timestamp||null,
    fx_source_currency:latest.fx_source_currency||null,
    fx_target_currency:latest.fx_target_currency||null,
    fx_engine_version:latest.fx_engine_version||null,
    snapshot_date:latest.snapshot_date,
    snapshot_created_at:latest.snapshot_created_at||latest.created_at||null,
    account_currency:latest.account_currency,
    kpis,
    purchase_journey,
    click_journey,
    performance_summary:{rows:performanceRows,counts},
    daily_snapshots:daily.map(s=>({
      snapshot_date:s.snapshot_date,
      snapshot_version:s.snapshot_version,
      snapshot_id:s.id||null,
      snapshot_created_at:s.snapshot_created_at||s.created_at||null,
      date_preset:s.date_preset||null,
      capture_reason:s.capture_reason||null,
      snapshot_class:s.snapshot_class||null,
      platform_account_timezone:s.platform_account_timezone||null,
      platform_business_date:s.platform_business_date||null,
      fx_rate:s.fx_rate??null,
      fx_provider:s.fx_provider||null,
      fx_source_currency:s.fx_source_currency||null,
      fx_target_currency:s.fx_target_currency||null,
      fx_engine_version:s.fx_engine_version||null
    }))
  };
}

app.get("/api/snapshots/meta/latest",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const requestedAdAccountId=req.query.adAccountId||req.query.ad_account_id||req.query.platform_account_id;
    let platformAccountId=normalizePlatformAccountId(requestedAdAccountId);
    let conn=null;
    let platformTimeZone=DEFAULT_PLATFORM_TIMEZONE;
    try{
      conn=await getConnection(user.id,"meta");
      platformAccountId=platformAccountId||normalizePlatformAccountId(conn?.account_id||conn?.metadata?.lastOwnedPlatformAccountId||conn?.metadata?.selectedPlatformAccountId);
      if(platformAccountId)platformTimeZone=await getPlatformAccountTimezone(user.id,"meta",platformAccountId,conn,null);
    }catch{}

    const scope=resolveSnapshotDateScope(req.query||{},platformTimeZone);
    const isRangeScope=["last_7_days","this_month","custom"].includes(scope.dateFilter);

    let snapshotQuery=supabaseAdmin
      .from("dashboard_snapshots")
      .select("id,platform,platform_account_id,platform_base_currency,snapshot_version,source_job_id,date_preset,snapshot_period_start,snapshot_period_end,snapshot_scope,capture_reason,snapshot_class,platform_account_timezone,platform_business_date,platform_business_hour,server_time_utc,istanbul_time,platform_account_time,time_engine_version,fx_rate,fx_provider,fx_rate_timestamp,fx_source_currency,fx_target_currency,fx_engine_version,snapshot_date,snapshot_created_at,created_at,account_currency,kpis,purchase_journey,click_journey,performance_summary")
      .eq("user_id",user.id)
      .neq("snapshot_class","recovery");

    if(platformAccountId)snapshotQuery=snapshotQuery.eq("platform_account_id",platformAccountId);
    if(scope.start)snapshotQuery=snapshotQuery.gte("snapshot_date",scope.start);
    if(scope.end)snapshotQuery=snapshotQuery.lte("snapshot_date",scope.end);

    const {data,error}=await snapshotQuery
      .order("snapshot_date",{ascending:false})
      .order("snapshot_version",{ascending:false})
      .order("created_at",{ascending:false})
      .limit(isRangeScope?500:1);

    if(error)throw error;

    let snapshot=null;
    if(isRangeScope){
      snapshot=aggregateSnapshots(data||[],scope);
    }else{
      snapshot=normalizeSnapshotForResponse((data||[])[0]||null);
    }

    res.json({
      ok:true,
      platform:"Meta",
      date_scope:{
        ...scope,
        platform_account_timezone:platformTimeZone,
        platform_account_id:platformAccountId||null,
        server_time_utc:new Date().toISOString(),
        istanbul_time:timePartsInZone(new Date(),"Europe/Istanbul").text,
        platform_account_time:timePartsInZone(new Date(),platformTimeZone).text
      },
      snapshot
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});


// ===== END PHASE E.2C META SNAPSHOT READ =====



app.get("/api/debug/time-sync",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    const platform=String(req.query.platform||"meta");
    const conn=await getConnection(user.id,platform).catch(()=>null);
    const platformAccountId=normalizePlatformAccountId(req.query.platform_account_id||req.query.adAccountId||conn?.account_id||conn?.metadata?.lastOwnedPlatformAccountId||conn?.metadata?.selectedPlatformAccountId);
    const platformTimeZone=platformAccountId?await getPlatformAccountTimezone(user.id,platform,platformAccountId,conn,null):DEFAULT_PLATFORM_TIMEZONE;
    const sync=resolveAdminTimeSync(new Date(),platformTimeZone);
    res.json({ok:true,platform,platform_account_id:platformAccountId||null,...sync,automation_hours:AUTOMATION_PLATFORM_HOURS,data_maturity_window_hours:dataMaturityWindowHours(platform),time_engine_version:TIME_ENGINE_VERSION});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get("/api/unified/status",async(req,res)=>{const user=await requireUser(req,res);if(!user)return;const meta=await connectionStatus(user.id,"meta"),google=await connectionStatus(user.id,"google"),pinterest=await connectionStatus(user.id,"pinterest"),klaviyo=await connectionStatus(user.id,"klaviyo");res.json({meta:meta.connected,google:google.connected,pinterest:pinterest.connected,klaviyo:klaviyo.connected,tiktok:false,tiktokStatus:"pending_verification",sources:{meta:meta.source,google:google.source,pinterest:pinterest.source,klaviyo:klaviyo.source},updatedAt:{meta:meta.updatedAt,google:google.updatedAt,pinterest:pinterest.updatedAt,klaviyo:klaviyo.updatedAt}})});
app.get("/api/debug/connections",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const{data,error}=await supabaseAdmin.from("platform_connections").select("platform,connected,account_id,account_name,token_expires_at,metadata,updated_at").eq("user_id",user.id).order("updated_at",{ascending:false});if(error)throw error;res.json({connections:data||[]})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/connections/:platform/disconnect",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const platform=req.params.platform;if(!["meta","google","pinterest","klaviyo"].includes(platform))return res.status(400).json({error:"Unsupported platform"});const result=await disconnectPlatformLifecycle(user.id,platform);res.json(result)}catch(e){res.status(e.status||500).json({error:e.message})}});
async function upsertAdAccount(userId,platform,account){
  if(!supabaseAdmin||!userId)return null;
  const row={
    user_id:userId,
    platform,
    platform_business_id:account.business_id||null,
    platform_account_id:normalizePlatformAccountId(account.id||account.customerId||account.account_id||account.platform_account_id),
    account_name:account.name||account.descriptiveName||account.account_name||null,
    currency:account.currency||account.currency_code||null,
    timezone:account.timezone_name||account.timezone||null,
    status:String(account.account_status||account.status||""),
    metadata:account,
    updated_at:new Date().toISOString()
  };
  if(!row.platform_account_id)return null;
  const ownership=await ensurePlatformOwnership(userId,platform,row);
  await supabaseAdmin.from("platform_ad_accounts").upsert(row,{onConflict:"user_id,platform,platform_account_id"});
  await saveConnection(userId,platform,{accountId:row.platform_account_id,accountName:row.account_name,metadata:{lastOwnedPlatformAccountId:row.platform_account_id,baseCurrency:row.currency}});
  return ownership;
}
async function metaGraph(pathname,params,token){const url=new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${pathname}`);Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=="")url.searchParams.set(k,v)});url.searchParams.set("access_token",token);const r=await fetch(url);const data=await r.json();if(!r.ok)throw new Error(data.error?.message||JSON.stringify(data));return data}
app.get("/api/meta/adaccounts",async(req,res)=>{try{const result=await requireConnection(req,res,"meta");if(!result)return;const{user,conn}=result;const data=await metaGraph("/me/adaccounts",{fields:"id,name,account_status,currency,timezone_name",limit:"100"},conn.access_token);const accounts=data.data||[];for(const account of accounts)await upsertAdAccount(user.id,"meta",account);res.json({platform:"meta",accounts})}catch(e){res.status(500).json({error:e.message})}});
function actionValue(list,type){const f=Array.isArray(list)?list.find(x=>x.action_type===type):null;return f?Number(f.value||0):null}
function normalizeMetaInsight(row,level){const a=row.actions||[],c=row.cost_per_action_type||[],v=row.action_values||[];const addToCart=actionValue(a,"add_to_cart")??actionValue(a,"omni_add_to_cart");const checkout=actionValue(a,"initiate_checkout")??actionValue(a,"checkout")??actionValue(a,"omni_initiated_checkout");const purchase=actionValue(a,"purchase")??actionValue(a,"omni_purchase");const purchaseValue=actionValue(v,"purchase")??actionValue(v,"omni_purchase");const addToCartValue=actionValue(v,"add_to_cart")??actionValue(v,"omni_add_to_cart");const checkoutValue=actionValue(v,"initiate_checkout")??actionValue(v,"checkout")??actionValue(v,"omni_initiated_checkout");const abandoned=Math.max((checkout||0)-(purchase||0),0);const spend=Number(row.spend||0);const revenue=purchaseValue??null;return{platform:"Meta",level,campaign_id:row.campaign_id||null,campaign_name:row.campaign_name||null,campaign_status:row.campaign_status||null,adset_id:row.adset_id||null,adset_name:row.adset_name||null,ad_id:row.ad_id||null,ad_name:row.ad_name||null,currency:row.account_currency||null,impressions:Number(row.impressions||0),reach:Number(row.reach||0),clicks:Number(row.clicks||0),ctr:row.ctr!==undefined?Number(row.ctr):null,cpc:row.cpc!==undefined?Number(row.cpc):null,spend,link_clicks:actionValue(a,"link_click"),landing_page_views:actionValue(a,"landing_page_view"),omni_landing_page_views:actionValue(a,"omni_landing_page_view"),page_engagement:actionValue(a,"page_engagement"),post_engagement:actionValue(a,"post_engagement"),video_views:actionValue(a,"video_view"),add_to_cart:addToCart,checkout,purchase,purchases:purchase,abandoned,add_to_cart_value:addToCartValue,checkout_value:checkoutValue,purchase_value:purchaseValue,cost_per_link_click:actionValue(c,"link_click"),cost_per_landing_page_view:actionValue(c,"landing_page_view"),cost_per_page_engagement:actionValue(c,"page_engagement"),cost_per_video_view:actionValue(c,"video_view"),conversion_rate_ranking:row.conversion_rate_ranking||null,sales:revenue,revenue,roas:spend&&spend>0&&revenue!==null?revenue/spend:null,date_start:row.date_start||null,date_stop:row.date_stop||null,raw:row}}
app.get("/api/meta/insights",async(req,res)=>{try{const result=await requireConnection(req,res,"meta");if(!result)return;const{conn}=result;const adAccountId=req.query.adAccountId||req.query.ad_account_id;if(!adAccountId)return res.status(400).json({error:"Missing adAccountId"});const level=["campaign","adset","ad"].includes(String(req.query.level||"campaign"))?String(req.query.level||"campaign"):"campaign";const fields=["campaign_id","campaign_name","account_currency","impressions","reach","clicks","ctr","cpc","spend","actions","action_values","cost_per_action_type","conversion_rate_ranking"];if(level==="adset")fields.splice(2,0,"adset_id","adset_name");if(level==="ad")fields.splice(2,0,"adset_id","adset_name","ad_id","ad_name");const data=await metaGraph(`/${adAccountId}/insights`,{level,date_preset:req.query.date_preset||"last_7d",fields:fields.join(","),limit:req.query.limit||"100"},conn.access_token);res.json({platform:"Meta",level,date_preset:req.query.date_preset||"last_7d",rows:(data.data||[]).map(r=>normalizeMetaInsight(r,level)),paging:data.paging||null})}catch(e){res.status(500).json({error:e.message})}});
function normalizeCustomerId(id){return String(id||"").replace(/-/g,"").trim()}
function googleHeaders(token,loginCustomerId){const h={Authorization:`Bearer ${token}`,"developer-token":process.env.GOOGLE_DEVELOPER_TOKEN||"","Content-Type":"application/json"};if(loginCustomerId)h["login-customer-id"]=normalizeCustomerId(loginCustomerId);return h}
async function googleAdsSearch(userId,customerId,query,loginCustomerId){const token=await getFreshGoogleAccessToken(userId);const clean=normalizeCustomerId(customerId);const r=await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${clean}/googleAds:search`,{method:"POST",headers:googleHeaders(token,loginCustomerId),body:JSON.stringify({query})});const data=await r.json();if(!r.ok){const err=new Error(JSON.stringify(data));err.status=r.status;throw err}return data}
function googleDateClause(range){return range==="today"?"segments.date DURING TODAY":range==="yesterday"?"segments.date DURING YESTERDAY":range==="last_30d"?"segments.date DURING LAST_30_DAYS":"segments.date DURING LAST_7_DAYS"}
function googleQuery(level,range){const d=googleDateClause(range);if(level==="adgroup")return `SELECT segments.date, customer.currency_code, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, metrics.impressions, metrics.clicks, metrics.invalid_clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.conversions_from_interactions_rate FROM ad_group WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT 100`;if(level==="ad")return `SELECT segments.date, customer.currency_code, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, metrics.impressions, metrics.clicks, metrics.invalid_clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.conversions_from_interactions_rate FROM ad_group_ad WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT 100`;return `SELECT segments.date, customer.currency_code, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, bidding_strategy.type, metrics.impressions, metrics.clicks, metrics.invalid_clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.conversions_from_interactions_rate FROM campaign WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT 100`}
function googleConversionBreakdownQuery(level,range){const d=googleDateClause(range);if(level==="adgroup")return `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM ad_group WHERE ${d} AND metrics.conversions > 0 LIMIT 1000`;if(level==="ad")return `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE ${d} AND metrics.conversions > 0 LIMIT 1000`;return `SELECT campaign.id, campaign.name, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${d} AND metrics.conversions > 0 LIMIT 1000`}
function googleRowKey(row,level){const c=row.campaign||{},ag=row.adGroup||row.ad_group||{},aga=row.adGroupAd||row.ad_group_ad||{};if(level==="ad")return String(c.id||"")+"|"+String(ag.id||"")+"|"+String(nested(aga,"ad.id")||"");if(level==="adgroup")return String(c.id||"")+"|"+String(ag.id||"");return String(c.id||"")}
function googleConversionName(row){const s=row.segments||{},ca=row.conversionAction||row.conversion_action||{};return String(s.conversionActionName||s.conversion_action_name||ca.name||ca.resourceName||ca.resource_name||"").toLowerCase()}
function googleConversionCategory(row){const s=row.segments||{},ca=row.conversionAction||row.conversion_action||{};return String(s.conversionActionCategory||s.conversion_action_category||ca.category||"").toUpperCase()}
function googleMetricNumber(row,key){const m=row.metrics||{};return Number(m[key]??m[key.replace(/[A-Z]/g,x=>"_"+x.toLowerCase())]??0)}
function mergeGoogleConversionActions(performanceRows,breakdownRows,level){const byKey=new Map();for(const r of performanceRows)byKey.set(googleRowKey(r,level),r);for(const b of breakdownRows||[]){const key=googleRowKey(b,level);const target=byKey.get(key);if(!target)continue;target.__conversion_actions=target.__conversion_actions||[];target.__conversion_actions.push({name:googleConversionName(b),category:googleConversionCategory(b),conversions:googleMetricNumber(b,"conversions"),conversions_value:googleMetricNumber(b,"conversionsValue")});}return performanceRows}
function microsToMoney(v){return v===null||v===undefined||v===""?null:Number(v)/1000000}
function nested(o,p){return p.split(".").reduce((a,k)=>a&&a[k]!==undefined?a[k]:undefined,o)}
function googleMatchConversion(actions,kind){const list=Array.isArray(actions)?actions:[];const cfg={add_to_cart:{categories:["ADD_TO_CART"],names:["add_to_cart","add to cart","cart"]},checkout:{categories:["BEGIN_CHECKOUT"],names:["begin_checkout","checkout","start_checkout","started_checkout"]},purchase:{categories:["PURCHASE"],names:["purchase","placed_order","order","sale"]}}[kind];if(!cfg)return null;let total=0,value=0,found=false;for(const a of list){const name=String(a.name||"").toLowerCase();const cat=String(a.category||"").toUpperCase();const matched=cfg.categories.includes(cat)||cfg.names.some(n=>name.includes(n));if(matched){found=true;total+=Number(a.conversions||0);value+=Number(a.conversions_value||0)}}return found?{count:total,value}:null}
function normalizeGoogleInsight(row,level){const m=row.metrics||{},c=row.campaign||{},ag=row.adGroup||row.ad_group||{},aga=row.adGroupAd||row.ad_group_ad||{},cust=row.customer||{},seg=row.segments||{};const spend=microsToMoney(m.costMicros??m.cost_micros),cpc=microsToMoney(m.averageCpc??m.average_cpc),genericRevenue=Number(m.conversionsValue??m.conversions_value??0),genericConversions=Number(m.conversions??0),invalidClicks=Number(m.invalidClicks??m.invalid_clicks??0),clicks=Number(m.clicks||0),validClicks=Math.max(clicks-invalidClicks,0);const actions=row.__conversion_actions||[];const atc=googleMatchConversion(actions,"add_to_cart"),chk=googleMatchConversion(actions,"checkout"),pur=googleMatchConversion(actions,"purchase");const addToCart=atc?atc.count:null,checkout=chk?chk.count:null,purchase=pur?pur.count:null,purchaseValue=pur?pur.value:genericRevenue||null;const abandoned=checkout!==null&&purchase!==null?Math.max((checkout||0)-(purchase||0),0):null;const sales=purchaseValue;const roas=spend&&spend>0&&sales!==null?sales/spend:null;const acos=sales&&sales>0&&spend!==null?(spend/sales)*100:null;return{platform:"Google",level,date:seg.date||null,campaign_id:c.id||null,campaign_name:c.name||null,campaign_status:c.status||null,channel_type:c.advertisingChannelType||c.advertising_channel_type||null,bidding_strategy_type:nested(row,"biddingStrategy.type")||nested(row,"bidding_strategy.type")||null,adgroup_id:ag.id||null,adgroup_name:ag.name||null,adgroup_status:ag.status||null,ad_id:nested(aga,"ad.id")||null,ad_status:aga.status||null,currency:cust.currencyCode||cust.currency_code||null,impressions:Number(m.impressions||0),clicks,ad_clicks:clicks,link_clicks:clicks,landing_page_views:null,traffic_score:null,real_cpc:null,invalid_clicks:invalidClicks,valid_clicks:validClicks,ctr:m.ctr!==undefined?Number(m.ctr)*100:null,cpc,spend,conversions:genericConversions,all_conversions:Number(m.allConversions??m.all_conversions??0),add_to_cart:addToCart,checkout,purchase,purchases:purchase,abandoned,purchase_value:purchaseValue,revenue:sales,sales,conversion_rate:m.conversionsFromInteractionsRate!==undefined?Number(m.conversionsFromInteractionsRate)*100:m.conversions_from_interactions_rate!==undefined?Number(m.conversions_from_interactions_rate)*100:null,cvr:clicks&&purchase!==null?(purchase/clicks)*100:null,roas,acos,conversion_actions:actions,raw:row}}
app.get("/api/google/customers",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const token=await getFreshGoogleAccessToken(user.id);const r=await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,{method:"GET",headers:googleHeaders(token)});const data=await r.json();if(!r.ok)return res.status(r.status).json({error:JSON.stringify(data),status:r.status});const customers=(data.resourceNames||[]).map(resourceName=>({resourceName,customerId:String(resourceName).replace("customers/","")}));for(const c of customers)await upsertAdAccount(user.id,"google",{id:c.customerId,customerId:c.customerId,name:c.customerId,status:"accessible"});res.json({customers})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/google/insights",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const customerId=req.query.customerId||req.query.customer_id;if(!customerId)return res.status(400).json({error:"Missing customerId"});const level=["campaign","adgroup","ad"].includes(String(req.query.level||"campaign"))?String(req.query.level||"campaign"):"campaign";const dateRange=String(req.query.date_range||req.query.dateRange||"last_7d");const loginCustomerId=req.query.loginCustomerId||req.query.login_customer_id||"";const query=googleQuery(level,dateRange);const data=await googleAdsSearch(user.id,customerId,query,loginCustomerId);let breakdownData={results:[]},breakdownError=null;try{breakdownData=await googleAdsSearch(user.id,customerId,googleConversionBreakdownQuery(level,dateRange),loginCustomerId)}catch(err){breakdownError=err.message}const performanceRows=data.results||[];const mergedRows=mergeGoogleConversionActions(performanceRows,breakdownData.results||[],level);res.json({platform:"Google",level,customerId:normalizeCustomerId(customerId),loginCustomerId:loginCustomerId?normalizeCustomerId(loginCustomerId):null,date_range:dateRange,rows:mergedRows.map(r=>normalizeGoogleInsight(r,level)),rawCount:mergedRows.length,conversionBreakdownCount:breakdownData.results?breakdownData.results.length:0,conversionBreakdownError:breakdownError,fieldMask:data.fieldMask||null,conversionFieldMask:breakdownData.fieldMask||null,requestId:data.requestId||null,nextPageToken:data.nextPageToken||null})}catch(e){res.status(e.status||500).json({error:e.message})}});
async function pinterestFetch(conn,endpoint,options={}){const r=await fetch(`${PINTEREST_API_BASE}${endpoint}`,{...options,headers:{Authorization:`Bearer ${conn.access_token}`,"Content-Type":"application/json",...(options.headers||{})}});const text=await r.text();let data;try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!r.ok)throw new Error(data.message||text||`Pinterest API error ${r.status}`);return data}

function dateRangeToPinterestDates(range){
  const end=new Date();
  const start=new Date(end);
  if(range==="today"){}
  else if(range==="yesterday"){start.setDate(start.getDate()-1);end.setDate(end.getDate()-1)}
  else if(range==="last_30d")start.setDate(start.getDate()-29);
  else start.setDate(start.getDate()-6);
  const fmt=d=>d.toISOString().slice(0,10);
  return{start_date:fmt(start),end_date:fmt(end)};
}
function num(v){return v===null||v===undefined||v===""?0:Number(v)||0}
function maybeNum(v){return v===null||v===undefined||v===""?null:Number(v)}
function microToMoneyPinterest(v){const n=maybeNum(v);return n===null?null:n/1000000}
function firstMetric(m,...keys){for(const k of keys){if(m&&m[k]!==undefined&&m[k]!==null)return m[k]}return null}
function sumMetrics(m,...keys){let found=false,total=0;for(const k of keys){const v=firstMetric(m,k);if(v!==null&&v!==undefined&&v!==""){found=true;total+=Number(v)||0}}return found?total:null}
function normalizePinterestInsight(row,level){
  const m=row.metrics||row||{};
  const campaign=row.campaign||{};
  const adGroup=row.ad_group||row.adGroup||{};
  const ad=row.ad||{};
  const customer=row.customer||{};
  const seg=row.segments||{};
  const impressions=num(firstMetric(m,"impressions","IMPRESSION_1","PAID_IMPRESSION","TOTAL_IMPRESSION"));
  const clicks=num(firstMetric(m,"clicks","CLICKTHROUGH_1","CLICKTHROUGH_1_GROSS","TOTAL_CLICKTHROUGH"));
  const outboundClicks=maybeNum(firstMetric(m,"OUTBOUND_CLICK_1","OUTBOUND_CLICK_2","OUTBOUND_CLICK","outbound_clicks","outboundClicks"));
  const lpv=maybeNum(firstMetric(m,"TOTAL_PAGE_VISIT","TOTAL_WEB_SESSIONS","WEB_SESSIONS_1","WEB_SESSIONS_2","LANDING_PAGE_VIEW","landing_page_views","landingPageViews"));
  const spend=microToMoneyPinterest(firstMetric(m,"spend_in_micro_dollar","SPEND_IN_MICRO_DOLLAR"));
  const addToCart=firstMetric(m,"TOTAL_ADD_TO_CART")!==null?maybeNum(firstMetric(m,"TOTAL_ADD_TO_CART")):sumMetrics(m,"TOTAL_CLICK_ADD_TO_CART","TOTAL_VIEW_ADD_TO_CART");
  const checkout=maybeNum(firstMetric(m,"TOTAL_CHECKOUT","TOTAL_WEB_CHECKOUT","TOTAL_CLICK_CHECKOUT","TOTAL_VIEW_CHECKOUT"));
  const purchase=maybeNum(firstMetric(m,"TOTAL_WEB_CHECKOUT","TOTAL_CHECKOUT","TOTAL_CONVERSIONS"));
  const addToCartValue=microToMoneyPinterest(firstMetric(m,"TOTAL_ADD_TO_CART_VALUE_IN_MICRO_DOLLAR"));
  const checkoutValue=microToMoneyPinterest(firstMetric(m,"TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR","TOTAL_WEB_CHECKOUT_VALUE_IN_MICRO_DOLLAR"));
  const purchaseValue=microToMoneyPinterest(firstMetric(m,"TOTAL_WEB_CHECKOUT_VALUE_IN_MICRO_DOLLAR","TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR","TOTAL_PURCHASE_VALUE_IN_MICRO_DOLLAR","TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR"));
  const abandoned=checkout!==null&&purchase!==null?Math.max((checkout||0)-(purchase||0),0):null;
  const cartAbandoned=addToCart!==null&&checkout!==null?Math.max((addToCart||0)-(checkout||0),0):null;
  const cvr=outboundClicks&&outboundClicks>0&&purchase!==null?(purchase/outboundClicks)*100:null;
  const roas=spend&&spend>0&&purchaseValue!==null?purchaseValue/spend:null;
  const acos=purchaseValue&&purchaseValue>0&&spend!==null?spend/purchaseValue:null;
  return{platform:"Pinterest",level,date:seg.date||row.date||null,report_level:row.report_level||null,campaign_id:campaign.id||row.campaign_id||null,campaign_name:campaign.name||row.campaign_name||null,campaign_status:campaign.status||null,objective_type:campaign.objective_type||campaign.objectiveType||null,adgroup_id:adGroup.id||row.ad_group_id||null,adgroup_name:adGroup.name||row.ad_group_name||null,adgroup_status:adGroup.status||null,ad_id:ad.id||row.ad_id||null,pin_id:ad.pin_id||ad.pinId||null,ad_status:ad.status||null,currency:customer.currency||customer.currency_code||null,impressions,reach:null,clicks,link_clicks:outboundClicks,outbound_clicks:outboundClicks,landing_page_views:lpv,ctr:firstMetric(m,"ctr","CTR")!==null?Number(firstMetric(m,"ctr","CTR"))*100:null,cpc:firstMetric(m,"average_cpc","CPC_IN_MICRO_DOLLAR")!==null?(firstMetric(m,"average_cpc")!==null?Number(firstMetric(m,"average_cpc")):microToMoneyPinterest(firstMetric(m,"CPC_IN_MICRO_DOLLAR"))):null,spend,save_rate:maybeNum(firstMetric(m,"save_rate","SAVE_RATE")),add_to_cart:addToCart,checkout,purchase,purchases:purchase,abandoned,cart_abandoned:cartAbandoned,add_to_cart_value:addToCartValue,checkout_value:checkoutValue,purchase_value:purchaseValue,sales:purchaseValue,revenue:purchaseValue,cvr,roas,acos,raw:row};
}
function pinterestAnalyticsEndpoint(adAccountId,level){
  if(level==="adgroup")return `/ad_accounts/${adAccountId}/ad_groups/analytics`;
  if(level==="ad")return `/ad_accounts/${adAccountId}/ads/analytics`;
  if(level==="account")return `/ad_accounts/${adAccountId}/analytics`;
  return `/ad_accounts/${adAccountId}/campaigns/analytics`;
}
function normalizePinterestRows(data,level){
  const rows=Array.isArray(data)?data:Array.isArray(data.items)?data.items:Array.isArray(data.data)?data.data:Array.isArray(data.results)?data.results:[];
  return rows.map(r=>normalizePinterestInsight(r,level));
}
app.get("/api/pinterest/insights",async(req,res)=>{try{const result=await requireConnection(req,res,"pinterest");if(!result)return;const{conn}=result;const adAccountId=req.query.adAccountId||req.query.ad_account_id;if(!adAccountId)return res.status(400).json({error:"Missing adAccountId"});const level=["account","campaign","adgroup","ad"].includes(String(req.query.level||"campaign"))?String(req.query.level||"campaign"):"campaign";const dateRange=String(req.query.date_range||req.query.dateRange||"last_7d");const dates=req.query.start_date&&req.query.end_date?{start_date:String(req.query.start_date),end_date:String(req.query.end_date)}:dateRangeToPinterestDates(dateRange);const defaultColumns="SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1,OUTBOUND_CLICK_1,TOTAL_PAGE_VISIT,TOTAL_CLICK_ADD_TO_CART,TOTAL_VIEW_ADD_TO_CART,TOTAL_CHECKOUT,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR,TOTAL_WEB_CHECKOUT,TOTAL_WEB_CHECKOUT_VALUE_IN_MICRO_DOLLAR";const params=new URLSearchParams({start_date:dates.start_date,end_date:dates.end_date,granularity:String(req.query.granularity||"DAY"),columns:String(req.query.columns||defaultColumns),click_window_days:String(req.query.click_window_days||30),engagement_window_days:String(req.query.engagement_window_days||30),view_window_days:String(req.query.view_window_days||1),conversion_report_time:String(req.query.conversion_report_time||"TIME_OF_AD_ACTION")});const campaignIds=req.query.campaign_ids||req.query.campaignIds||"";const adGroupIds=req.query.ad_group_ids||req.query.adGroupIds||"";const adIds=req.query.ad_ids||req.query.adIds||"";if(level==="campaign"&&!campaignIds)return res.status(400).json({error:"Parameter 'campaign_ids' is required."});if(level==="adgroup"&&!adGroupIds)return res.status(400).json({error:"Parameter 'ad_group_ids' is required."});if(level==="ad"&&!adIds)return res.status(400).json({error:"Parameter 'ad_ids' is required."});if(campaignIds)params.set("campaign_ids",String(campaignIds));if(adGroupIds)params.set("ad_group_ids",String(adGroupIds));if(adIds)params.set("ad_ids",String(adIds));const endpoint=`${pinterestAnalyticsEndpoint(adAccountId,level)}?${params.toString()}`;const data=await pinterestFetch(conn,endpoint);const normalizedRows=normalizePinterestRows(data,level);res.json({platform:"Pinterest",level,adAccountId,date_range:dateRange,start_date:dates.start_date,end_date:dates.end_date,campaign_ids:campaignIds||null,ad_group_ids:adGroupIds||null,ad_ids:adIds||null,rows:normalizedRows,rawCount:normalizedRows.length,raw:data})}catch(e){res.status(500).json({error:e.message})}});

app.get("/api/pinterest/adaccounts",async(req,res)=>{try{const result=await requireConnection(req,res,"pinterest");if(!result)return;const{user,conn}=result;const data=await pinterestFetch(conn,"/ad_accounts");const accounts=data.items||[];for(const account of accounts)await upsertAdAccount(user.id,"pinterest",{id:account.id,name:account.name,currency:account.currency,status:"accessible",...account});res.json(data)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/accounts",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const{data,error}=await supabaseAdmin.from("platform_ad_accounts").select("*").eq("user_id",user.id).order("platform",{ascending:true});if(error)throw error;res.json({accounts:data||[]})}catch(e){res.status(500).json({error:e.message})}});


// ===== D.2A.1 META CONNECT / DISCONNECT =====
app.get("/api/platform/meta/status",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const conn=await getConnection(user.id,"meta");
    res.json({
      state: conn ? "CONNECTED" : "NOT_CONNECTED"
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/platform/meta/disconnect",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    const result=await disconnectPlatformLifecycle(user.id,"meta");
    res.json({state:"NOT_CONNECTED",...result});
  }catch(e){
    res.status(e.status||500).json({error:e.message});
  }
});
// ===== END D.2A.1 META CONNECT / DISCONNECT =====


// ===== D.2A.2 GOOGLE CONNECT / DISCONNECT =====
app.get("/api/platform/google/status",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const conn=await getConnection(user.id,"google");
    res.json({
      state: conn ? "CONNECTED" : "NOT_CONNECTED"
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/platform/google/disconnect",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    const result=await disconnectPlatformLifecycle(user.id,"google");
    res.json({state:"NOT_CONNECTED",...result});
  }catch(e){
    res.status(e.status||500).json({error:e.message});
  }
});
// ===== END D.2A.2 GOOGLE CONNECT / DISCONNECT =====


// ===== D.2B.1 KLAVIYO CONNECT / DISCONNECT + ESTIMATED MONTHLY SPEND =====
app.get("/api/platform/klaviyo/status",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const conn=await getConnection(user.id,"klaviyo");
    const estimated=conn?.metadata?.estimated_monthly_spend||null;

    res.json({
      state: conn ? "CONNECTED" : "NOT_CONNECTED",
      estimated_monthly_spend: estimated
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/platform/klaviyo/disconnect",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    const result=await disconnectPlatformLifecycle(user.id,"klaviyo");
    res.json({state:"NOT_CONNECTED",...result});
  }catch(e){
    res.status(e.status||500).json({error:e.message});
  }
});

app.post("/api/platform/klaviyo/estimated-spend",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const conn=await getConnection(user.id,"klaviyo");
    if(!conn)return res.status(404).json({error:"Klaviyo not connected"});

    const amount=Number(req.body?.amount);
    const currency=String(req.body?.currency||"").trim().toUpperCase();

    if(!amount||amount<=0)return res.status(400).json({error:"Amount is required."});
    if(!["USD","TRY","EUR","GBP"].includes(currency))return res.status(400).json({error:"Currency is required."});

    const metadata={
      ...(conn.metadata||{}),
      estimated_monthly_spend:{
        amount,
        currency
      }
    };

    const {error}=await supabaseAdmin
      .from("platform_connections")
      .update({
        metadata,
        updated_at:new Date().toISOString()
      })
      .eq("user_id",user.id)
      .eq("platform","klaviyo");

    if(error)throw error;

    res.json({
      message:"Saved",
      estimated_monthly_spend:metadata.estimated_monthly_spend
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});
// ===== END D.2B.1 KLAVIYO CONNECT / DISCONNECT + ESTIMATED MONTHLY SPEND =====

// ===== PHASE C ACCOUNT MANAGEMENT API =====
async function syncPublicUserFromAuth(user){
  if(!supabaseAdmin||!user?.id)throw new Error("Supabase not configured or user missing");
  const authEmail=user.email||null;
  const metaName=user.user_metadata?.name||user.user_metadata?.full_name||null;
  const now=new Date().toISOString();

  const {data:existing,error:selectError}=await supabaseAdmin
    .from("users")
    .select("id,email,name,account_currency")
    .eq("id",user.id)
    .maybeSingle();

  if(selectError)throw selectError;

  if(!existing){
    const {error:insertError}=await supabaseAdmin
      .from("users")
      .insert({id:user.id,email:authEmail,name:metaName,account_currency:null,updated_at:now});
    if(insertError)throw insertError;
    return {id:user.id,email:authEmail,name:metaName,account_currency:null};
  }

  const patch={updated_at:now};
  let changed=false;

  if(authEmail&&existing.email!==authEmail){
    patch.email=authEmail;
    changed=true;
  }

  if(changed){
    const {data,error}=await supabaseAdmin
      .from("users")
      .update(patch)
      .eq("id",user.id)
      .select("id,email,name,account_currency")
      .maybeSingle();
    if(error)throw error;
    return data;
  }

  return existing;
}

app.get("/api/account/profile",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;
    const profile=await syncPublicUserFromAuth(user);
    res.json({profile,authEmail:user.email||null});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/account/profile",async(req,res)=>{
  try{
    const user=await requireUser(req,res);
    if(!user)return;

    const name=typeof req.body?.name==="string"?req.body.name.trim():null;
    if(!name)return res.status(400).json({error:"Name is required."});

    await syncPublicUserFromAuth(user);

    const {data,error}=await supabaseAdmin
      .from("users")
      .update({name,updated_at:new Date().toISOString()})
      .eq("id",user.id)
      .select("id,email,name,account_currency")
      .maybeSingle();

    if(error)throw error;
    res.json({profile:data,message:"Saved"});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});
// ===== END PHASE C ACCOUNT MANAGEMENT API =====



// ===== D.1 V2 ACCOUNT CURRENCY REQUIRED =====
const SUPPORTED_ACCOUNT_CURRENCIES=["USD","TRY","EUR","GBP"];
function normalizeAccountCurrency(value){const c=String(value||"").trim().toUpperCase();return SUPPORTED_ACCOUNT_CURRENCIES.includes(c)?c:null}
app.get("/api/account/currency",async(req,res)=>{try{const user=await requireLifecycleAccess(req,res,"dashboard");if(!user)return;await syncPublicUserFromAuth(user.user);const{data,error}=await supabaseAdmin.from("users").select("account_currency").eq("id",user.user.id).maybeSingle();if(error)throw error;res.json({account_currency:data?.account_currency||null,required:!data?.account_currency,supported:SUPPORTED_ACCOUNT_CURRENCIES})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/account/currency",async(req,res)=>{try{const user=await requireLifecycleAccess(req,res,"dashboard");if(!user)return;const accountCurrency=normalizeAccountCurrency(req.body?.account_currency);if(!accountCurrency)return res.status(400).json({error:"Please select your account currency."});await syncPublicUserFromAuth(user.user);const{data,error}=await supabaseAdmin.from("users").update({account_currency:accountCurrency,updated_at:new Date().toISOString()}).eq("id",user.user.id).select("id,email,name,account_currency").maybeSingle();if(error)throw error;res.json({profile:data,message:"Saved"})}catch(e){res.status(500).json({error:e.message})}});
// ===== END D.1 V2 ACCOUNT CURRENCY REQUIRED =====

// ===== PHASE C ACCOUNT LIFECYCLE + DELETE MY DATA =====
function normalizeAccountStatus(status){return String(status||"").toLowerCase()}
function getLifecycleAccess(status){const s=normalizeAccountStatus(status);const full=["trial","active"].includes(s);const readonly=["expired","cancelled"].includes(s);const blocked=["suspended","deleted"].includes(s);return{status:s||null,login:full||readonly,dashboard:full||readonly,snapshots:full||readonly,insightHistory:full||readonly,connect:full,manualRefresh:full,refresh:full,dailySync:full,export:full,aiInsights:full,blocked}}
async function getSubscriptionForLifecycle(userId){await expireTrialsIfNeeded();const{data,error}=await supabaseAdmin.from("subscriptions").select("status,trial_end_date").eq("user_id",userId).maybeSingle();if(error)throw error;return data}
async function requireLifecycleAccess(req,res,capability){const user=await requireUser(req,res);if(!user)return null;const sub=await getSubscriptionForLifecycle(user.id);const access=getLifecycleAccess(sub?.status);if(access.blocked||!access[capability]){res.status(403).json({error:"Account access blocked",status:access.status,capability});return null}return{user,sub,access}}
app.get("/api/account/status",async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;const sub=await getSubscriptionForLifecycle(user.id);const access=getLifecycleAccess(sub?.status);res.json({status:access.status,access,deleted_at:null,hard_delete_at:null})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/account/request-delete",async(req,res)=>{try{const result=await requireLifecycleAccess(req,res,"dashboard");if(!result)return;const token=crypto.randomBytes(32).toString("hex");const expiresAt=new Date(Date.now()+30*60*1000).toISOString();const{error}=await supabaseAdmin.from("subscriptions").update({deletion_token:token,deletion_token_expires_at:expiresAt,updated_at:new Date().toISOString()}).eq("user_id",result.user.id).in("status",["trial","active","expired","cancelled"]);if(error)throw error;const proto=req.headers["x-forwarded-proto"]||req.protocol||"https";const host=req.headers["x-forwarded-host"]||req.headers.host;const confirmationUrl=`${proto}://${host}/api/account/confirm-delete?token=${encodeURIComponent(token)}`;res.json({message:"Delete confirmation ready",confirmationUrl,tokenExpiresAt:expiresAt})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/account/confirm-delete",async(req,res)=>{try{const token=String(req.query.token||"");if(!token)return res.status(400).send("Missing delete token.");const{data,error}=await supabaseAdmin.from("subscriptions").select("user_id,status,deletion_token_expires_at").eq("deletion_token",token).maybeSingle();if(error)throw error;if(!data)return res.status(400).send("Invalid or expired delete token.");if(data.status==="deleted")return res.redirect("/login?account_deleted=1");const expiresAt=data.deletion_token_expires_at?new Date(data.deletion_token_expires_at).getTime():0;if(!expiresAt||expiresAt<Date.now())return res.status(400).send("Invalid or expired delete token.");const deletedAt=new Date();const hardDeleteAt=new Date(deletedAt.getTime()+90*24*60*60*1000);const{error:updateError}=await supabaseAdmin.from("subscriptions").update({status:"deleted",deleted_at:deletedAt.toISOString(),hard_delete_at:hardDeleteAt.toISOString(),deletion_token:null,deletion_token_expires_at:null,updated_at:deletedAt.toISOString()}).eq("user_id",data.user_id);if(updateError)throw updateError;res.redirect("/login?account_deleted=1")}catch(e){res.status(500).send(e.message)}});
// ===== END PHASE C ACCOUNT LIFECYCLE + DELETE MY DATA =====

app.get("/api/tiktok/status",(_,res)=>res.json({connected:false,status:"pending_verification"}));
if(process.env.VERCEL!=="1") app.listen(PORT,()=>console.log(`AdsTable server running on ${PORT}`));
module.exports=app;
