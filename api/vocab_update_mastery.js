// api/vocab_update_mastery.js (CommonJS for Railway/Node)
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "not_logged_in" });

  const { updates } = req.body || {};
  if (!Array.isArray(updates) || updates.length === 0)
    return res.status(400).json({ error: "missing_updates" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    for (const { id, mastery_level } of updates) {
      const level = Math.max(0, Math.min(2, parseInt(mastery_level, 10)));
      const { error } = await supabase
        .from("vocab_favorites")
        .update({ mastery_level: level })
        .eq("id", id);
      if (error) throw error;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "update_failed", detail: String(err?.message || err) });
  }
};
