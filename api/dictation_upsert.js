// api/dictation_upsert.js
// POST /api/dictation_upsert
// body: { clip_id, seg_index, input_text }
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

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });

  const payload = parseJWT(token);
  if (!payload?.sub) return res.status(401).json({ error: "unauthorized" });

  const userId = payload.sub;
  const { clip_id, seg_index, input_text } = req.body || {};

  if (!clip_id || seg_index === undefined || seg_index === null) {
    return res.status(400).json({ error: "missing_params" });
  }

  const { data, error } = await admin
    .from("dictation_history")
    .upsert(
      {
        user_id: userId,
        clip_id: String(clip_id),
        seg_index: Number(seg_index),
        input_text: input_text || "",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,clip_id,seg_index" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, data });
};
