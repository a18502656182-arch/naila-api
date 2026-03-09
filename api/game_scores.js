// api/game_scores.js
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

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "not_logged_in" });

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (!user) return res.status(401).json({ error: "invalid_token" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // GET：读取该用户所有游戏分数
    if (req.method === "GET") {
      const { data: rows, error } = await admin
        .from("game_scores")
        .select("game_id, best_score, play_count")
        .eq("user_id", user.id);

      if (error) return res.status(500).json({ error: "fetch_failed", detail: error.message });

      // 转成 { game_id: { best, playCount } } 格式
      const result = {};
      (rows || []).forEach(row => {
        result[row.game_id] = {
          best: row.best_score,
          playCount: row.play_count,
        };
      });

      const totalGameScore = (rows || []).reduce((sum, r) => sum + (r.best_score || 0), 0);
      const playedGameCount = (rows || []).filter(r => (r.play_count || 0) > 0).length;

      return res.status(200).json({ scores: result, totalGameScore, playedGameCount });
    }

    // POST：提交一局分数
    if (req.method === "POST") {
      const { game_id, score } = req.body || {};
      if (!game_id || score === undefined) {
        return res.status(400).json({ error: "missing_game_id_or_score" });
      }

      // 先读当前记录
      const { data: existing } = await admin
        .from("game_scores")
        .select("best_score, play_count")
        .eq("user_id", user.id)
        .eq("game_id", game_id)
        .single();

      const prevBest = existing?.best_score || 0;
      const prevCount = existing?.play_count || 0;
      const newBest = Math.max(prevBest, score);
      const newCount = prevCount + 1;

      const { error } = await admin
        .from("game_scores")
        .upsert(
          { user_id: user.id, game_id, best_score: newBest, play_count: newCount },
          { onConflict: "user_id,game_id" }
        );

      if (error) return res.status(500).json({ error: "save_failed", detail: error.message });

      return res.status(200).json({ ok: true, best_score: newBest, play_count: newCount });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};
