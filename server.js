const express = require("express");
const session = require("express-session");
const app = express();
const PORT = process.env.PORT || 3000;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const GRAPH_VERSION = "v20.0";

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false }
}));
app.use(express.static("public"));

function requireConfig() {
  if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
    throw new Error("Missing Replit Secrets: META_APP_ID / META_APP_SECRET / META_REDIRECT_URI");
  }
}

app.get("/api/config", (req, res) => {
  res.json({ metaConfigured: Boolean(META_APP_ID && META_APP_SECRET && META_REDIRECT_URI), redirectUri: META_REDIRECT_URI || null });
});

app.get("/auth/meta", (req, res) => {
  try {
    requireConfig();
    const state = Math.random().toString(36).slice(2);
    req.session.oauthState = state;
    const p = new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: META_REDIRECT_URI,
      state,
      response_type: "code",
      scope: "ads_read"
    });
    res.redirect(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${p.toString()}`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/auth/meta/callback", async (req, res) => {
  try {
    requireConfig();
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/?meta_error=${encodeURIComponent(error_description || error)}`);
    if (!code) return res.redirect("/?meta_error=Missing authorization code");
    if (!state || state !== req.session.oauthState) return res.redirect("/?meta_error=Invalid OAuth state");

    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    url.searchParams.set("client_id", META_APP_ID);
    url.searchParams.set("redirect_uri", META_REDIRECT_URI);
    url.searchParams.set("client_secret", META_APP_SECRET);
    url.searchParams.set("code", code);

    const r = await fetch(url.toString());
    const data = await r.json();
    if (!r.ok || !data.access_token) throw new Error(data.error?.message || "Token exchange failed");

    req.session.meta = { accessToken: data.access_token, connectedAt: new Date().toISOString() };
    res.redirect("/?meta_connected=1");
  } catch (e) {
    res.redirect(`/?meta_error=${encodeURIComponent(e.message)}`);
  }
});

app.post("/auth/meta/logout", (req, res) => {
  delete req.session.meta;
  res.json({ ok: true });
});

app.get("/api/meta/status", (req, res) => {
  res.json({ connected: Boolean(req.session?.meta?.accessToken), connectedAt: req.session?.meta?.connectedAt || null });
});

async function graphGet(path, params, token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const r = await fetch(url.toString());
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

app.get("/api/meta/adaccounts", async (req, res) => {
  try {
    if (!req.session?.meta?.accessToken) return res.status(401).json({ error: "Meta not connected" });
    const data = await graphGet("/me/adaccounts", {
      fields: "id,name,account_status,currency,timezone_name",
      limit: "50"
    }, req.session.meta.accessToken);
    res.json({ accounts: data.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function datePreset(range) {
  if (range === "yesterday") return "yesterday";
  if (range === "7d") return "last_7d";
  return "today";
}

function actionVal(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find(a => a.action_type === type);
  return found ? Number(found.value || 0) : 0;
}

function parseInsight(row) {
  const sales = actionVal(row.action_values, "purchase") ||
    actionVal(row.action_values, "offsite_conversion.fb_pixel_purchase") ||
    actionVal(row.action_values, "onsite_conversion.purchase");
  const purchases = actionVal(row.actions, "purchase") ||
    actionVal(row.actions, "offsite_conversion.fb_pixel_purchase") ||
    actionVal(row.actions, "onsite_conversion.purchase");
  return {
    name: row.campaign_name || "Unknown campaign",
    id: row.campaign_id || "",
    imp: Number(row.impressions || 0),
    click: Number(row.clicks || 0),
    spend: Number(row.spend || 0),
    sales,
    purchases
  };
}

app.get("/api/meta/insights", async (req, res) => {
  try {
    if (!req.session?.meta?.accessToken) return res.status(401).json({ error: "Meta not connected" });
    const adAccountId = req.query.adAccountId;
    const range = req.query.range || "today";
    if (!adAccountId) return res.status(400).json({ error: "Missing adAccountId" });

    const data = await graphGet(`/${adAccountId}/insights`, {
      level: "campaign",
      fields: "campaign_id,campaign_name,impressions,clicks,spend,actions,action_values",
      date_preset: datePreset(range),
      limit: "100"
    }, req.session.meta.accessToken);

    res.json({ platform: "Meta", range, campaigns: (data.data || []).map(parseInsight) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Ads Table Meta running on http://localhost:${PORT}`));
