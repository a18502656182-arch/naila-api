// api/pay_create.js
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ZPAY_PID = "2026040811105714";
const ZPAY_KEY = process.env.ZPAY_KEY || "p9AmtnMaUTjFlid4mWqokSby12PiyZCf";
const ZPAY_GATEWAY = "https://zpayz.cn/submit.php";
const API_BASE_URL = process.env.API_BASE_URL || "https://railway.nailaobao.top";

const PLANS = {
  month:    { label: "月卡会员",  days: 30,  amount: "19.80" },
  quarter:  { label: "季卡会员",  days: 90,  amount: "38.80" },
  year:     { label: "年卡会员",  days: 365, amount: "66.80" },
  lifetime: { label: "永久会员",  days: 0,   amount: "168.80" },
};

// 各站点显示名称
const SITE_NAMES = {
  yt: "油管英语场景库",
  drama: "影视英语场景库",
};

function nanoid(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function genOrderNo() {
  return Date.now() + Math.floor(Math.random() * 10000).toString().padStart(4, "0");
}

function zpaySign(params) {
  const keys = Object.keys(params)
    .filter(k => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== null && params[k] !== undefined)
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join("&") + ZPAY_KEY;
  return crypto.createHash("md5").update(str).digest("hex");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // site 参数：yt 或 drama，不传默认 yt
  const { plan, return_url, site: rawSite } = req.body || {};
  const site = rawSite === "drama" ? "drama" : "yt";

  if (!PLANS[plan]) return res.status(400).json({ error: "invalid_plan" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let planInfo = { ...PLANS[plan] };
  if (plan === "lifetime") {
    const { data: cfg } = await admin.from("site_config").select("value").eq("key", "lifetime_price").single();
    if (cfg?.value) planInfo.amount = cfg.value;
  }

  const out_trade_no = genOrderNo();
  let redeem_code;
  while (true) {
    redeem_code = nanoid(12);
    const { data } = await admin.from("redeem_codes").select("code").eq("code", redeem_code).maybeSingle();
    if (!data) break;
  }

  // orders 表记录 site
  const { error: orderErr } = await admin.from("orders").insert({
    out_trade_no: String(out_trade_no),
    plan,
    days: planInfo.days,
    amount: planInfo.amount,
    redeem_code,
    status: "pending",
    site,
  });
  if (orderErr) return res.status(500).json({ error: "order_create_failed", detail: orderErr.message });

  // 预先写入 redeem_codes，带 site 字段
  const { error: codeErr } = await admin.from("redeem_codes").insert({
    code: redeem_code,
    plan,
    days: planInfo.days,
    max_uses: 1,
    used_count: 0,
    is_active: false,
    site,
    created_at: new Date().toISOString(),
  });
  if (codeErr) return res.status(500).json({ error: "code_create_failed", detail: codeErr.message });

  const site_url = return_url?.replace(/\/buy.*/, "") || "https://nailaobao.top";
  const finalReturnUrl = `${site_url}/buy/result?order=${out_trade_no}`;
  const finalNotifyUrl = `${API_BASE_URL}/api/pay_notify`;

  const siteName = SITE_NAMES[site] || "油管英语场景库";

  const params = {
    pid: ZPAY_PID,
    type: "alipay",
    out_trade_no: String(out_trade_no),
    notify_url: finalNotifyUrl,
    return_url: finalReturnUrl,
    name: planInfo.label,
    money: planInfo.amount,
    sitename: siteName,
  };

  params.sign = zpaySign(params);
  params.sign_type = "MD5";

  const query = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const payUrl = `${ZPAY_GATEWAY}?${query}`;

  return res.status(200).json({
    ok: true,
    pay_url: payUrl,
    out_trade_no: String(out_trade_no),
    redeem_code,
  });
};
