import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ====== CORS：允许前端域名（非常关键）======
const ALLOW_ORIGINS = [
  "https://www.nailaobao.top",
  "https://nailaobao.top",
  "https://naila-clips-eo9w.vercel.app",
];

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// ====== Supabase Admin（Service Role）======
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ====== 工具函数 ======
function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .flatMap((x) => String(x).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
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

app.get("/", (req, res) => res.send("naila-api ok"));

// ====== /api/me（Bearer token 验证）======
app.get("/api/me", async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }

    const u = data.user;
    return res.json({
      ok: true,
      user: { id: u.id, email: u.email },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== /api/clips（保留：你现在测试用）======
app.get("/api/clips", async (req, res) => {
  try {
    const offset = parseInt(req.query.offset || "0", 10);
    const limit = parseInt(req.query.limit || "12", 10);

    const { data, error } = await supabaseAdmin
      .from("clips_view")
      .select("*")
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, items: data || [], offset, limit });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== /rsc-api/clips（前端列表真正用的）======
app.get("/rsc-api/clips", async (req, res) => {
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

    q = q
      .order("created_at", { ascending: sort === "oldest" })
      .range(offset, offset + take - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    const has_more = rows.length > limit;
    const pageRows = has_more ? rows.slice(0, limit) : rows;

    const items = pageRows.map(normRow);

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
});

// ====== /rsc-api/taxonomies（前端筛选真正用的）======
app.get("/rsc-api/taxonomies", async (req, res) => {
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
      normalized
        .filter((c) => matches(c, f))
        .forEach((c) => inc(counts.difficulty, c.difficulty));
    }

    // access counts（放开 access）
    {
      const f = {
        access: [],
        difficulty: selectedDifficulty,
        topic: selectedTopic,
        channel: selectedChannel,
      };
      normalized
        .filter((c) => matches(c, f))
        .forEach((c) => inc(counts.access, c.access_tier));
    }

    // topic counts（放开 topic）
    {
      const f = {
        access: selectedAccess,
        difficulty: selectedDifficulty,
        topic: [],
        channel: selectedChannel,
      };
      normalized
        .filter((c) => matches(c, f))
        .forEach((c) => (c.topics || []).forEach((t) => inc(counts.topic, t)));
    }

    // channel counts（放开 channel）
    {
      const f = {
        access: selectedAccess,
        difficulty: selectedDifficulty,
        topic: selectedTopic,
        channel: [],
      };
      normalized
        .filter((c) => matches(c, f))
        .forEach((c) => (c.channels || []).forEach((ch) => inc(counts.channel, ch)));
    }

    const difficultiesWithCount = sortByCountThenName(
      difficulties.map((x) => ({
        slug: x.slug,
        name: x.slug,
        count: counts.difficulty[x.slug] || 0,
      }))
    );

    const topicsWithCount = sortByCountThenName(
      topics.map((x) => ({
        slug: x.slug,
        name: x.slug,
        count: counts.topic[x.slug] || 0,
      }))
    );

    const channelsWithCount = sortByCountThenName(
      channels.map((x) => ({
        slug: x.slug,
        name: x.slug,
        count: counts.channel[x.slug] || 0,
      }))
    );

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.json({
      difficulties: difficultiesWithCount,
      topics: topicsWithCount,
      channels: channelsWithCount,
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
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on port", port));
