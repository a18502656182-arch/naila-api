// api/redeem.js
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function calcNewExpiry(existingExpiresAt, days) {
  const d = Number(days ?? 0);
  if (d === 0) return null; // 永久卡
  const safeDays = Number.isFinite(d) && d > 0 ? d : 30;
  const msToAdd = safeDays * 24 * 60 * 60 * 1000;
  if (existingExpiresAt) {
    const existing = new Date(existingExpiresAt).getTime();
    if (Number.isFinite(existing) && existing > Date.now()) {
      return new Date(existing + msToAdd).toISOString();
    }
  }
  return new Date(Date.now() + msToAdd).toISOString();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const code = (req.body?.code || "").trim();
    if (!code) return res.status(400).json({ error: "missing_code" });

    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: "not_logged_in" });

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error: userErr } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (userErr || !user?.id) return res.status(401).json({ error: "not_logged_in" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: rc, error: rcErr } = await admin
      .from("redeem_codes")
      .select("code, plan, days, max_uses, used_count, expires_at, is_active, site")
      .eq("code", code)
      .maybeSingle();

    if (rcErr) return res.status(500).json({ error: "db_read_failed", detail: rcErr.message });
    if (!rc || !rc.is_active) return res.status(400).json({ error: "invalid_code" });

    if (rc.expires_at) {
      const exp = new Date(rc.expires_at).getTime();
      if (Number.isFinite(exp) && exp < Date.now()) return res.status(400).json({ error: "code_expired" });
    }

    const used = Number(rc.used_count || 0);
    const max = Number(rc.max_uses || 0);
    if (max > 0 && used >= max) return res.status(400).json({ error: "code_used_up" });

    if (rc.plan === "trial") {
      const { data: profile } = await admin
        .from("profiles")
        .select("used_trial")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profile?.used_trial) {
        return res.status(400).json({ error: "trial_already_used" });
      }
    }

    // 兑换码的 site 字段决定开哪个站的会员，默认 yt
    const site = rc.site || "yt";

    // 查该用户在对应 site 的现有订阅
    const { data: existingSub } = await admin
      .from("subscriptions")
      .select("expires_at, status")
      .eq("user_id", user.id)
      .eq("site", site)
      .maybeSingle();

    const new_expires_at = calcNewExpiry(existingSub?.expires_at || null, rc.days);

    // upsert 时带上 site 字段，用 user_id+site 作为唯一标识
    const { error: subErr } = await admin
      .from("subscriptions")
      .upsert(
        { user_id: user.id, status: "active", plan: rc.plan || "month", expires_at: new_expires_at, site },
        { onConflict: "user_id,site" }
      );
    if (subErr) return res.status(500).json({ error: "subscription_upsert_failed", detail: subErr.message });

    await admin.from("redeem_codes").update({ used_count: used + 1 }).eq("code", code);

    const profileUpdate = { user_id: user.id, used_code: code };
    if (rc.plan === "trial") profileUpdate.used_trial = true;
    await admin.from("profiles").upsert(profileUpdate, { onConflict: "user_id" });

    return res.status(200).json({ ok: true, plan: rc.plan || "month", expires_at: new_expires_at, site });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};
