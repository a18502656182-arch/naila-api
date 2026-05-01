// api/me.js
const { createClient } = require("@supabase/supabase-js");

// 油管站 Supabase（主库）
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 美剧站 Supabase（副库，只用来查会员状态）
const DRAMA_SUPABASE_URL = process.env.DRAMA_SUPABASE_URL;
const DRAMA_SUPABASE_SERVICE_ROLE_KEY = process.env.DRAMA_SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseJWT(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

function calcIsMember(sub) {
  if (!sub || sub.status !== "active") return false;
  const end_at = sub.expires_at || null;
  if (!end_at) return true; // 永久卡
  const endMs = new Date(end_at).getTime();
  return !Number.isNaN(endMs) && endMs > Date.now();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  try {
    const token = getBearer(req);
    if (!token) return res.status(200).json({ logged_in: false, is_member: false, is_member_yt: false, is_member_drama: false });

    const payload = parseJWT(token);
    if (!payload?.sub) return res.status(200).json({ logged_in: false, is_member: false, is_member_yt: false, is_member_drama: false });

    const userId = payload.sub;
    const email = payload.email || null;

    // 查油管站订阅（主库，按site=yt过滤）
    const [{ data: subYt }, { data: profile }] = await Promise.all([
      admin.from("subscriptions").select("status, plan, expires_at").eq("user_id", userId).eq("site", "yt").maybeSingle(),
      admin.from("profiles").select("username").eq("user_id", userId).maybeSingle(),
    ]);

    // 查美剧站订阅（主库，按site=drama过滤）
    const { data: subDrama } = await admin
      .from("subscriptions")
      .select("status, plan, expires_at")
      .eq("user_id", userId)
      .eq("site", "drama")
      .maybeSingle();

    const is_member_yt = calcIsMember(subYt);
    const is_member_drama = calcIsMember(subDrama);

    // is_member 兼容旧逻辑：油管站页面继续用这个字段
    const is_member = is_member_yt;

    return res.status(200).json({
      logged_in: true,
      email,
      username: profile?.username || null,
      user_id: userId,
      is_member,
      is_member_yt,
      is_member_drama,
      plan: subYt?.plan || null,
      status: subYt?.status || null,
      ends_at: subYt?.expires_at || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
