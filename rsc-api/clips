const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function normRow(r) {
  const difficulty = typeof r.difficulty_slug === "string" ? r.difficulty_slug : null;
  const topics = Array.isArray(r.topic_slugs) ? r.topic_slugs : [];
  const channels = Array.isArray(r.channel_slugs) ? r.channel_slugs : [];
  return {
    id: r.id,
    title: r.title ?? "",
    description: r.description ?? null,
    duration_sec: r.duration_sec ?? null,
    created_at: r.created_at,
    upload_time: r.upload_time ?? null,
    access_tier: r.access_tier,
    cover_url: r.cover_url ? r.cover_url : null,
    video_url: r.video_url ?? null,
    difficulty,
    topics,
    channels,
  };
}

module.exports = async function handler(req, res) {
  try {
    const difficulty = parseList(req.query.difficulty);
    const access = parseList(req.query.access);
    const topic = parseList(req.query.topic);
    const channel = parseList(req.query.channel);

    const sort = req.query.sort === "oldest" ? "oldest" : "newest";
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10), 1), 50);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const take = Math.min(limit + 1, 51);

    let q = supabaseAdmin
      .from("clips_view")
      .select(
        "id,title,description,duration_sec,created_at,upload_time,access_tier,cover_url,video_url,difficulty_slug,topic_slugs,channel_slugs"
      );

    if (access.length) {
      const expanded = [];
      for (const a of access) {
        if (a === "member") expanded.push("member", "vip");
        else expanded.push(a);
      }
      q = q.in("access_tier", Array.from(new Set(expanded)));
    }

    if (difficulty.length) q = q.in("difficulty_slug", difficulty);
    if (topic.length) q = q.overlaps("topic_slugs", topic);
    if (channel.length) q = q.overlaps("channel_slugs", channel);

    q = q.order("created_at", { ascending: sort === "oldest" }).range(offset, offset + take - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    const has_more = rows.length > limit;
    const pageRows = has_more ? rows.slice(0, limit) : rows;

    const items = pageRows.map(normRow);

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.json({
      items,
      total: null,
      limit,
      offset,
      has_more,
      sort,
      filters: { difficulty, access, topic, channel },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
