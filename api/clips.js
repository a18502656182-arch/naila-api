// api/clips.js (CommonJS for Railway/Node)
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// imagedelivery.net 在国内被墙，转成 Vercel 反代路径 /cf-img/...
function proxyCoverUrl(url) {
  if (!url) return null;
  if (url.startsWith("https://imagedelivery.net")) {
    return "/cf-img" + url.slice("https://imagedelivery.net".length);
  }
  return url;
}

// 视频 m3u8 通过后端反代，解决运营商拦截问题
function proxyVideoUrl(url) {
  if (!url) return null;
  return `/api/proxy_video?url=${encodeURIComponent(url)}`;
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) v = v.join(",");
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function getUserFromBearer() {
  // placeholder, actual implemented in handler with anon client
}

async function getMembership(admin, userId) {
  const now = Date.now();

  const tryQuery = async (dateCol) => {
    const { data, error } = await admin
      .from("subscriptions")
      .select(`status, plan, ${dateCol}`)
      .eq("user_id", userId)
      .order(dateCol, { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return { data, error, dateCol };
  };

  let r = await tryQuery("ends_at");
  if (
    r.error &&
    String(r.error.message || "").toLowerCase().includes("column") &&
    String(r.error.message || "").includes("ends_at")
  ) {
    r = await tryQuery("expires_at");
  }

  if (r.error) {
    return {
      is_member: false,
      debug: { ok: false, reason: "query_error", message: r.error.message, used: r.dateCol },
    };
  }

  const sub = r.data;
  if (!sub) return { is_member: false, debug: { ok: false, reason: "no_subscription_row", used: r.dateCol } };

  const status = sub.status ?? null;
  const plan = sub.plan ?? null;
  const end_at = sub[r.dateCol] ?? null;

  let is_member = false;
  if (status === "active") {
    if (!end_at) is_member = true;
    else {
      const endMs = new Date(end_at).getTime();
      if (!Number.isNaN(endMs) && endMs > now) is_member = true;
    }
  }

  return { is_member, debug: { ok: true, used: r.dateCol, raw: { status, plan, end_at } } };
}

module.exports = async function handler(req, res) {
  // ✅ 关键：永远不缓存 /api/clips（避免会员态被边缘缓存污染）
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

    const difficulty = parseList(req.query.difficulty);
    const access = parseList(req.query.access);
    const topic = parseList(req.query.topic);
    const channel = parseList(req.query.channel);

    const sort = req.query.sort === "oldest" ? "oldest" : "newest";
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10), 1), 50);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    // ====== 1) 解析 Bearer -> user ======
    const token = getBearer(req);
    let user = null;
    let userErr = null;

    if (token) {
      const r = await anon.auth.getUser(token);
      user = r?.data?.user || null;
      userErr = r?.error || null;
    }

    let is_member = false;
    let sub_debug = { ok: false, reason: "not_logged_in" };

    if (user?.id && !userErr) {
      const m = await getMembership(admin, user.id);
      is_member = !!m.is_member;
      sub_debug = m.debug;
    }

    // ====== 2) 轻量候选集合：clips + clip_taxonomies + taxonomies ======
    // 这里为了保持你原来的筛选语义（difficulty/topic/channel 都来自 clip_taxonomies），
    // 我们拉取完整候选后在内存里做匹配，然后分页，再回查 fullRows。
    let q = admin
      .from("clips")
      .select(
        `
        id, access_tier, created_at,
        clip_taxonomies (
          taxonomies ( type, slug )
        )
      `
      )
      .order("created_at", { ascending: sort === "oldest" });

    if (access.length) q = q.in("access_tier", access);

    const { data: lightRows, error: lightErr } = await q;
    if (lightErr) return res.status(500).json({ error: lightErr.message });

    const normalized = (lightRows || []).map((row) => {
      const all = (row.clip_taxonomies || []).map((ct) => ct.taxonomies).filter(Boolean);
      const diff = all.find((t) => t.type === "difficulty")?.slug || null;
      const topics = all.filter((t) => t.type === "topic").map((t) => t.slug);
      const channels = all.filter((t) => t.type === "channel").map((t) => t.slug);

      return {
        id: row.id,
        created_at: row.created_at,
        access_tier: row.access_tier,
        difficulty: diff,
        topics,
        channels,
      };
    });

    function matches(clip) {
      if (difficulty.length) {
        if (!clip.difficulty || !difficulty.includes(clip.difficulty)) return false;
      }
      if (topic.length) {
        if (!(clip.topics || []).some((t) => topic.includes(t))) return false;
      }
      if (channel.length) {
        if (!(clip.channels || []).some((c) => channel.includes(c))) return false;
      }
      return true;
    }

    const matched = normalized.filter(matches);
    const total = matched.length;
    const page = matched.slice(offset, offset + limit);
    const pageIds = page.map((x) => x.id);
    const has_more = offset + limit < total;

    if (!pageIds.length) {
      return res.status(200).json({
        debug: {
          mode: "db_paged",
          has_user: !!user?.id,
          user_id: user?.id || null,
          userErr: userErr?.message || null,
          sub_debug,
        },
        items: [],
        total,
        limit,
        offset,
        has_more,
        sort,
        filters: { difficulty, access, topic, channel },
        is_member,
      });
    }

    // ====== 3) 回查 fullRows（保持你原版返回字段结构）======
    const { data: fullRows, error: fullErr } = await admin
      .from("clips")
      .select(
        `
        id, title, description, duration_sec, created_at, upload_time,
        access_tier, cover_url, video_url,
        clip_taxonomies(
          taxonomies(type, slug)
        )
      `
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
          difficulty: diff,
          topics,
          channels,
          can_access,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      debug: {
        mode: "db_paged",
        has_user: !!user?.id,
        user_id: user?.id || null,
        userErr: userErr?.message || null,
        sub_debug,
      },
      items,
      total,
      limit,
      offset,
      has_more,
      sort,
      filters: { difficulty, access, topic, channel },
      is_member,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
