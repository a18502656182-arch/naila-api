// api/bookmarks_add.js (CommonJS)
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
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: "not_logged_in", debug: { mode: "bearer", userErr: "missing_token" } });

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error: userErr } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (userErr || !user?.id) {
      return res.status(401).json({ error: "not_logged_in", debug: { mode: "bearer", userErr: userErr?.message || "no_user" } });
    }

    const { clip_id } = req.body || {};
    const cid = Number(clip_id);
    if (!cid) return res.status(400).json({ error: "missing_clip_id" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // ✅ 需要 bookmarks 表有唯一约束 (user_id, clip_id)
    const { error } = await admin
      .from("bookmarks")
      .upsert({ user_id: user.id, clip_id: cid }, { onConflict: "user_id,clip_id" });

    if (error) {
      return res.status(500).json({ error: "bookmark_insert_failed", detail: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "unknown", detail: String(e?.message || e) });
  }
};
