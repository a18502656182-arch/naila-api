// api/journal_stats.js
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
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "not_logged_in" });

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data } = await anon.auth.getUser(token);
    const user = data?.user || null;
    if (!user) return res.status(401).json({ error: "invalid_token" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const today = new Date().toISOString().slice(0, 10);

    // 并行查询所有数据
    const [
      todayViewsRes,
      allViewsRes,
      todayVocabRes,
      masteredRes,
      bookmarksRes,
    ] = await Promise.all([
      // 今日观看数
      admin.from("view_logs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("viewed_date", today),

      // 热力图：过去 90 天所有观看记录
      admin.from("view_logs")
        .select("viewed_date")
        .eq("user_id", user.id)
        .gte("viewed_date", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),

      // 今日新增词汇数
      admin.from("vocab_favorites")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", `${today}T00:00:00.000Z`),

      // 已掌握词汇总数
      admin.from("vocab_favorites")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("mastery_level", 2),

      // 收藏视频的 topic_slugs（用于偏好分析）
      admin.from("bookmarks")
        .select("clip_id")
        .eq("user_id", user.id),
    ]);

    // 热力图数据整理：{ "2026-03-01": 3, ... }
    const heatmap = {};
    (allViewsRes.data || []).forEach(row => {
      const d = row.viewed_date;
      heatmap[d] = (heatmap[d] || 0) + 1;
    });

    // 连续学习天数计算
    let streak = 0;
    const checkDate = new Date();
    checkDate.setHours(0, 0, 0, 0);
    while (true) {
      const key = checkDate.toISOString().slice(0, 10);
      if (heatmap[key]) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        // 今天还没学，从昨天开始算
        if (key === today && streak === 0) {
          checkDate.setDate(checkDate.getDate() - 1);
          continue;
        }
        break;
      }
    }

    // 总观看视频数（去重 clip_id）
    const allViewsAll = await admin.from("view_logs")
      .select("clip_id")
      .eq("user_id", user.id);
    const uniqueClips = new Set((allViewsAll.data || []).map(r => r.clip_id));

    // 收藏视频的话题（需要再查 clips_view）
    let bookmarkedTopics = [];
    const bookmarkClipIds = (bookmarksRes.data || []).map(r => r.clip_id);
    if (bookmarkClipIds.length > 0) {
      const clipsRes = await admin.from("clips_view")
        .select("topic_slugs")
        .in("id", bookmarkClipIds.slice(0, 50)); // 最多取50个
      (clipsRes.data || []).forEach(clip => {
        if (Array.isArray(clip.topic_slugs)) {
          bookmarkedTopics = bookmarkedTopics.concat(clip.topic_slugs);
        }
      });
    }

    return res.status(200).json({
      today_views: todayViewsRes.count || 0,
      total_views: uniqueClips.size,
      today_vocab: todayVocabRes.count || 0,
      mastered_total: masteredRes.count || 0,
      streak_days: streak,
      heatmap,
      bookmarked_topics: bookmarkedTopics,
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};
