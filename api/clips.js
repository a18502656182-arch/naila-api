// api/clips.js (CommonJS for Railway/Node)
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function proxyCoverUrl(url) {
  if (!url) return null;
  if (url.startsWith("https://imagedelivery.net")) {
    return "/cf-img" + url.slice("https://imagedelivery.net".length);
  }
  return url;
}

function proxyVideoUrl(url) {
  if (!url) return null;
  return `/api/proxy_video?url=${encodeURIComponent(url)}`;
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) v = v.join(",");
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function getMembership(admin, userId, site) {
  const now = Date.now();

  // 按 site 查对应的订阅
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("status, plan, expires_at")
    .eq("user_id", userId)
    .eq("site", site)
    .maybeSingle();

  if (error) return { is_member: false };
  if (!sub || sub.status !== "active") return { is_member: false };

  const end_at = sub.expires_at || null;
  if (!end_at) return { is_member: true }; // 永久卡
  const endMs = new Date(end_at).getTime();
  return { is_member: !Number.isNaN(endMs) && endMs > now };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // site 参数：yt=油管，drama=美剧，不传=全部
    const site = req.query.site || null; // null 表示不过滤

    // 油管站筛选参数
    const difficulty = parseList(req.query.difficulty);
    const access = parseList(req.query.access);
    const topic = parseList(req.query.topic);
    const channel = parseList(req.query.channel);

    // 美剧站筛选参数
    const genre = req.query.genre || null;
    const duration = req.query.duration || null;
    const show = parseList(req.query.show);

    const sort = req.query.sort === "oldest" ? "oldest" : "newest";
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10), 1), 50);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    // ====== 1) 解析用户身份 ======
    const token = getBearer(req);
    let user = null;
    let userErr = null;

    if (token) {
      const r = await anon.auth.getUser(token);
      user = r?.data?.user || null;
      userErr = r?.error || null;
    }

    // 根据当前请求的 site 判断会员状态
    let is_member = false;
    if (user?.id && !userErr) {
      const effectiveSite = site || "yt"; // 不传 site 时默认用油管会员判断
      const m = await getMembership(admin, user.id, effectiveSite);
      is_member = !!m.is_member;
    }

    // ====== 2) 拉取候选集合做筛选 ======
    let q = admin
      .from("clips")
      .select(
        `id, access_tier, created_at,
        clip_taxonomies (
          taxonomies ( type, slug )
        )`
      )
      .order("created_at", { ascending: sort === "oldest" });

    // 按 site 过滤
    if (site) q = q.eq("site", site);

    if (access.length) q = q.in("access_tier", access);

    const { data: lightRows, error: lightErr } = await q;
    if (lightErr) return res.status(500).json({ error: lightErr.message });

    const normalized = (lightRows || []).map((row) => {
      const all = (row.clip_taxonomies || []).map((ct) => ct.taxonomies).filter(Boolean);
      const diff = all.find((t) => t.type === "difficulty")?.slug || null;
      const topics = all.filter((t) => t.type === "topic").map((t) => t.slug);
      const channels = all.filter((t) => t.type === "channel").map((t) => t.slug);
      const genres = all.filter((t) => t.type === "genre").map((t) => t.slug);
      const durations = all.filter((t) => t.type === "duration").map((t) => t.slug);
      const shows = all.filter((t) => t.type === "show").map((t) => t.slug);

      return {
        id: row.id,
        created_at: row.created_at,
        access_tier: row.access_tier,
        difficulty: diff,
        topics,
        channels,
        genres,
        durations,
        shows,
      };
    });

    function matches(clip) {
      // 油管站筛选
      if (difficulty.length && (!clip.difficulty || !difficulty.includes(clip.difficulty))) return false;
      if (topic.length && !(clip.topics || []).some((t) => topic.includes(t))) return false;
      if (channel.length && !(clip.channels || []).some((c) => channel.includes(c))) return false;
      // 美剧站筛选
      if (genre && !(clip.genres || []).includes(genre)) return false;
      if (duration && !(clip.durations || []).includes(duration)) return false;
      if (show.length && !(clip.shows || []).some((s) => show.includes(s))) return false;
      return true;
    }

    const matched = normalized.filter(matches);
    const total = matched.length;
    const page = matched.slice(offset, offset + limit);
    const pageIds = page.map((x) => x.id);
    const has_more = offset + limit < total;

    if (!pageIds.length) {
      return res.status(200).json({
        items: [],
        total,
        limit,
        offset,
        has_more,
        sort,
        filters: { difficulty, access, topic, channel, genre, duration, show, site },
        is_member,
      });
    }

    // ====== 3) 回查完整字段 ======
    const { data: fullRows, error: fullErr } = await admin
      .from("clips")
      .select(
        `id, title, description, duration_sec, created_at, upload_time,
        access_tier, cover_url, video_url, site,
        clip_taxonomies(
          taxonomies(type, slug)
        )`
      )
      .in("id", pageIds);

    if (fullErr) return res.status(500).json({ error: fullErr.message });

    const fullMap = new Map((fullRows || []).map((r) => [r.id, r]));

    const items = pageIds
      .map((id) => {
        const row = fullMap.get(id);
        if (!row) return null;

        const all = (row.clip_taxonomies || []).map((ct) => ct.taxonomies).filter(Boolean);
        const diff = all.find((t) => t.type === "difficulty")?.slug || null;
        const topics = all.filter((t) => t.type === "topic").map((t) => t.slug);
        const channels = all.filter((t) => t.type === "channel").map((t) => t.slug);
        const genres = all.filter((t) => t.type === "genre").map((t) => t.slug);
        const durations = all.filter((t) => t.type === "duration").map((t) => t.slug);
        const shows = all.filter((t) => t.type === "show").map((t) => t.slug);

        const can_access = row.access_tier === "free" ? true : Boolean(is_member);

        return {
          id: row.id,
          title: row.title,
          description: row.description ?? null,
          duration_sec: row.duration_sec ?? null,
          created_at: row.created_at,
          upload_time: row.upload_time ?? null,
          access_tier: row.access_tier,
          cover_url: proxyCoverUrl(row.cover_url),
          video_url: proxyVideoUrl(row.video_url),
          site: row.site || "yt",
          difficulty: diff,
          topics,
          channels,
          genres,
          durations,
          shows,
          can_access,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      items,
      total,
      limit,
      offset,
      has_more,
      sort,
      filters: { difficulty, access, topic, channel, genre, duration, show, site },
      is_member,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
