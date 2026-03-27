// api/clip_full.js (CommonJS for Railway/Node)
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const API_BASE = process.env.API_BASE || "";

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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const id = Number(req.query.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: "missing_id" });

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    let user = null;
    const token = getBearer(req);
    if (token) {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data } = await anon.auth.getUser(token);
      user = data?.user || null;
    }

    const [clipResult, detailResult, subResult, bookmarkResult] = await Promise.all([
      admin.from("clips_view")
        .select("id,title,description,duration_sec,access_tier,cover_url,video_url,created_at,difficulty_slug,topic_slugs,channel_slugs")
        .eq("id", id).maybeSingle(),
      admin.from("clip_details").select("details_json").eq("clip_id", id).maybeSingle(),
      user?.id
        ? admin.from("subscriptions").select("plan, expires_at, status")
            .eq("user_id", user.id).eq("status", "active")
            // 永久卡 expires_at 为 null，有效期卡 expires_at > now()，两种都算有效会员
            .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
            .order("expires_at", { ascending: false, nullsFirst: true }).limit(1)
        : Promise.resolve({ data: [], error: null }),
      user?.id
        ? admin.from("bookmarks").select("id").eq("user_id", user.id).eq("clip_id", id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (clipResult.error) return res.status(500).json({ error: "clip_query_failed", detail: clipResult.error.message });
    const clip = clipResult.data;
    if (!clip) return res.status(404).json({ error: "not_found" });

    const subRow = subResult.data?.[0] || null;
    const is_member = !!subRow;
    const can_access = clip.access_tier === "free" ? true : is_member;
    const bookmarked = !!bookmarkResult.data;

    let details_json = detailResult.data?.details_json ?? null;
    if (typeof details_json === "string") {
      try { details_json = JSON.parse(details_json); } catch { details_json = null; }
    }

    return res.status(200).json({
      ok: true,
      item: {
        id: clip.id, title: clip.title, description: clip.description,
        duration_sec: clip.duration_sec, access_tier: clip.access_tier,
        cover_url: proxyCoverUrl(clip.cover_url), video_url: can_access ? clip.video_url : null,
        created_at: clip.created_at, difficulty_slug: clip.difficulty_slug || null,
        topic_slugs: clip.topic_slugs || [], channel_slugs: clip.channel_slugs || [],
        can_access,
      },
      me: { logged_in: !!user, is_member, plan: subRow?.plan || null, ends_at: subRow?.expires_at || null, bookmarked },
      details_json: can_access ? details_json : null,
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};
