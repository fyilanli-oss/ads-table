const express = require("express");
const session = require("express-session");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;
const META_GRAPH_VERSION = "v20.0";

app.set("trust proxy", 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "change_me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: true
  }
}));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function requireMetaConfig() {
  if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
    throw new Error("Missing META_APP_ID / META_APP_SECRET / META_REDIRECT_URI");
  }
}

app.get("/auth/meta", (req, res) => {
  try {
    requireMetaConfig();

    const state = Math.random().toString(36).slice(2);
    req.session.metaOAuthState = state;

    const params = new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: META_REDIRECT_URI,
      state,
      response_type: "code",
      scope: "ads_read"
    });

    res.redirect(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/auth/meta/callback", async (req, res) => {
  try {
    requireMetaConfig();

    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.redirect(`/?meta_error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
      return res.redirect("/?meta_error=Missing authorization code");
    }

    if (!state || state !== req.session.metaOAuthState) {
      return res.redirect("/?meta_error=Invalid OAuth state");
    }

    const tokenUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", META_APP_ID);
    tokenUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error?.message || "Meta token exchange failed");
    }

    req.session.meta = {
      accessToken: tokenData.access_token,
      connectedAt: new Date().toISOString()
    };

    res.redirect("/?meta_connected=1");
  } catch (e) {
    res.redirect(`/?meta_error=${encodeURIComponent(e.message)}`);
  }
});

app.get("/api/meta/status", (req, res) => {
  res.json({
    connected: Boolean(req.session?.meta?.accessToken),
    connectedAt: req.session?.meta?.connectedAt || null
  });
});

async function metaGraphGet(pathname, params, accessToken) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${pathname}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", accessToken);

  const r = await fetch(url.toString());
  const data = await r.json();

  if (!r.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  return data;
}

app.get("/api/meta/adaccounts", async (req, res) => {
  try {
    if (!req.session?.meta?.accessToken) {
      return res.status(401).json({ error: "Meta not connected" });
    }

    const data = await metaGraphGet("/me/adaccounts", {
      fields: "id,name,account_status,currency,timezone_name",
      limit: "50"
    }, req.session.meta.accessToken);

    res.json({ accounts: data.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find(a => a.action_type === type);
  return found ? Number(found.value || 0) : 0;
}

function datePreset(range) {
  if (range === "yesterday") return "yesterday";
  if (range === "7d" || range === "last_7d") return "last_7d";
  if (range === "month" || range === "this_month") return "this_month";
  return "today";
}

app.get("/api/meta/insights", async (req, res) => {
  try {
    if (!req.session?.meta?.accessToken) {
      return res.status(401).json({ error: "Meta not connected" });
    }

    const adAccountId = req.query.adAccountId;
    const range = req.query.range || "today";

    if (!adAccountId) {
      return res.status(400).json({ error: "Missing adAccountId" });
    }

    const data = await metaGraphGet(`/${adAccountId}/insights`, {
      level: "campaign",
      fields: "campaign_id,campaign_name,impressions,clicks,spend,actions,action_values",
      date_preset: datePreset(range),
      limit: "100"
    }, req.session.meta.accessToken);

    const campaigns = (data.data || []).map(row => {
      const spend = Number(row.spend || 0);
      const clicks = Number(row.clicks || 0);
      const impressions = Number(row.impressions || 0);
      const sales =
        actionValue(row.action_values, "purchase") ||
        actionValue(row.action_values, "offsite_conversion.fb_pixel_purchase") ||
        actionValue(row.action_values, "onsite_conversion.purchase");

      return {
        platform: "Meta",
        id: row.campaign_id || "",
        name: row.campaign_name || "Unknown campaign",
        spend,
        sales,
        impressions,
        clicks,
        ctr: impressions ? clicks / impressions : 0,
        cpc: clicks ? spend / clicks : 0,
        roas: spend ? sales / spend : 0,
        acos: sales ? spend / sales : 0,
        raw: row
      };
    });

    res.json({
      platform: "Meta",
      range,
      campaigns
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => console.log(`AdsTable Meta recovery running on ${PORT}`));
}

module.exports = app;
