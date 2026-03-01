// api/me.js  (CommonJS for Railway/Node)
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const token = getBearer(req);
    if (!token) return res.status(200).json({ logged_in: false, is_member: false });

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (error || !user) return res.status(200).json({ logged_in: false, is_member: false });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data: sub } = await admin
      .from("subscriptions")
      .select("status, plan, expires_at")
      .eq("user_id", user.id)
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
      email: user.email,
      user_id: user.id,
      is_member,
      plan: sub?.plan || null,
      status: sub?.status || null,
      ends_at: end_at,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
