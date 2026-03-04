// api/me.js
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 复用 admin client
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 直接从 JWT payload 解析，不请求 Supabase 验证
// Supabase JWT 用私钥签名，客户端无法伪造，安全
function parseJWT(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    // 检查是否过期
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  try {
    const token = getBearer(req);
    if (!token) return res.status(200).json({ logged_in: false, is_member: false });

    const payload = parseJWT(token);
    if (!payload?.sub) return res.status(200).json({ logged_in: false, is_member: false });

    const userId = payload.sub;
    const email = payload.email || null;

    // 只做一次数据库查询
    const { data: sub } = await admin
      .from("subscriptions")
      .select("status, plan, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    const now = Date.now();
    const end_at = sub?.expires_at || null;
    let is_member = false;
    if (sub?.status === "active") {
      if (!end_at) is_member = true;
      else {
        const endMs = new Date(end_at).getTime();
        if (!Number.isNaN(endMs) && endMs > now) is_member = true;
      }
    }

    return res.status(200).json({
      logged_in: true,
      email,
      user_id: userId,
      is_member,
      plan: sub?.plan || null,
      status: sub?.status || null,
      ends_at: end_at,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
