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

function inc(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function sortByCountThenName(arr) {
  return (arr || []).slice().sort((a, b) => {
    const ca = a.count || 0;
    const cb = b.count || 0;
    if (cb !== ca) return cb - ca;
    return String(a.slug).localeCompare(String(b.slug));
  });
}

function matches(clip, f) {
  if (f.access?.length && !f.access.includes(clip.access_tier)) return false;

  if (f.difficulty?.length) {
    if (!clip.difficulty || !f.difficulty.includes(clip.difficulty)) return false;
  }

  if (f.topic?.length) {
    if (!(clip.topics || []).some((t) => f.topic.includes(t))) return false;
  }

  if (f.channel?.length) {
    if (!(clip.channels || []).some((c) => f.channel.includes(c))) return false;
  }

  return true;
}

module.exports = async function handler(req, res) {
  try {
    const sort = req.query.sort === "oldest" ? "oldest" : "newest";

    const selectedDifficulty = parseList(req.query.difficulty);
    const selectedAccess = parseList(req.query.access);
    const selectedTopic = parseList(req.query.topic);
    const selectedChannel = parseList(req.query.channel);

    const { data: taxRows, error: taxErr } = await supabaseAdmin
      .from("taxonomies")
      .select("type, slug")
      .order("type", { ascending: true })
      .order("slug", { ascending: true });

    if (taxErr) return res.status(500).json({ error: taxErr.message });

    const difficulties = (taxRows || []).filter((t) => t.type === "difficulty");
    const topics = (taxRows || []).filter((t) => t.type === "topic");
    const channels = (taxRows || []).filter((t) => t.type === "channel");

    let q = supabaseAdmin
      .from("clips_view")
      .select("access_tier,created_at,difficulty_slug,topic_slugs,channel_slugs")
      .order("created_at", { ascending: sort === "oldest" });

    if (selectedAccess.length) {
      const expanded = [];
      for (const a of selectedAccess) {
        if (a === "member") expanded.push("member", "vip");
        else expanded.push(a);
      }
      q = q.in("access_tier", Array.from(new Set(expanded)));
    }

    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) return res.status(500).json({ error: rowsErr.message });

    const normalized = (rows || []).map((r) => ({
      access_tier: r.access_tier,
      difficulty: typeof r.difficulty_slug === "string" ? r.difficulty_slug : null,
      topics: Array.isArray(r.topic_slugs) ? r.topic_slugs : [],
      channels: Array.isArray(r.channel_slugs) ? r.channel_slugs : [],
    }));

    const counts = { difficulty: {}, access: {}, topic: {}, channel: {} };

    // difficulty counts（放开 difficulty）
    {
      const f = {
        access: selectedAccess,
        difficulty: [],
        topic: selectedTopic,
        channel: selectedChannel,
      };
      normalized.filter((c) => matches(c, f)).forEach((c) => inc(counts.difficulty, c.difficulty));
    }

    // access counts（放开 access）
    {
      const f = {
        access: [],
        difficulty: selectedDifficulty,
        topic: selectedTopic,
        channel: selectedChannel,
      };
      normalized.filter((c) => matches(c, f)).forEach((c) => inc(counts.access, c.access_tier));
    }

    // topic counts（放开 topic）
    {
      const f = {
        access: selectedAccess,
        difficulty: selectedDifficulty,
        topic: [],
        channel: selectedChannel,
      };
      normalized.filter((c) => matches(c, f)).forEach((c) => (c.topics || []).forEach((t) => inc(counts.topic, t)));
    }

    // channel counts（放开 channel）
    {
      const f = {
        access: selectedAccess,
        difficulty: selectedDifficulty,
        topic: selectedTopic,
        channel: [],
      };
      normalized.filter((c) => matches(c, f)).forEach((c) => (c.channels || []).forEach((ch) => inc(counts.channel, ch)));
    }

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.json({
      difficulties: sortByCountThenName(
        difficulties.map((x) => ({ slug: x.slug, name: x.slug, count: counts.difficulty[x.slug] || 0 }))
      ),
      topics: sortByCountThenName(topics.map((x) => ({ slug: x.slug, name: x.slug, count: counts.topic[x.slug] || 0 }))),
      channels: sortByCountThenName(
        channels.map((x) => ({ slug: x.slug, name: x.slug, count: counts.channel[x.slug] || 0 }))
      ),
      access_counts: counts.access,
      filters: {
        difficulty: selectedDifficulty,
        access: selectedAccess,
        topic: selectedTopic,
        channel: selectedChannel,
        sort,
      },
      debug: { mode: "tax_with_counts_sorted_rsc_api" },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
