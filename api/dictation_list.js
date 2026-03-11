// api/dictation_list.js
// GET /api/dictation_list?clip_id=xxx
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  const token = getBearer(req);
  if (!token) return res.status(200).json({ items: [] });

  const payload = parseJWT(token);
  if (!payload?.sub) return res.status(200).json({ items: [] });

  const userId = payload.sub;
  const clip_id = req.query?.clip_id || req.body?.clip_id;

  if (!clip_id) return res.status(400).json({ error: "missing clip_id" });

  const { data, error } = await admin
    .from("dictation_history")
    .select("seg_index, input_text, updated_at")
    .eq("user_id", userId)
    .eq("clip_id", String(clip_id))
    .order("seg_index");

  if (error) return res.status(500).json({ error: error.message });

  // 转成 { [seg_index]: { input_text, updated_at } } 方便前端查找
  const map = {};
  (data || []).forEach(r => { map[r.seg_index] = { input_text: r.input_text, updated_at: r.updated_at }; });

  return res.status(200).json({ ok: true, items: data || [], map });
};
