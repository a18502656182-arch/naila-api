// api/bookmarks_has.js (CommonJS for Railway/Node)
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
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const token = getBearer(req);
    if (!token) return res.status(200).json({ has: false });

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error: userErr } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (userErr || !user?.id) return res.status(200).json({ has: false });

    const clip_id = Number(req.body?.clip_id);
    if (!clip_id) return res.status(400).json({ error: "missing_clip_id" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: row } = await admin
      .from("bookmarks")
      .select("id")
      .eq("user_id", user.id)
      .eq("clip_id", clip_id)
      .maybeSingle();

    return res.status(200).json({ has: !!row });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};
