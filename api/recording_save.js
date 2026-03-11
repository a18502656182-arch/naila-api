// api/recording_save.js
// POST /api/recording_save
// Body: multipart/form-data  { clip_id, segment_idx, duration_sec, file: audioBlob }
// 或 Body: application/octet-stream + query params

const { createClient } = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || "recordings";

function getS3() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });

  // 验证用户
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData } = await anon.auth.getUser(token);
  const user = userData?.user;
  if (!user) return res.status(401).json({ error: "invalid_token" });

  const clip_id = Number(req.query.clip_id || req.body?.clip_id);
  const segment_idx = Number(req.query.segment_idx ?? req.body?.segment_idx ?? -1);
  const duration_sec = Number(req.query.duration_sec || req.body?.duration_sec || 0) || null;
  const mime = req.headers["content-type"] || "audio/webm";

  if (!clip_id || segment_idx < 0) {
    return res.status(400).json({ error: "missing clip_id or segment_idx" });
  }

  // 收集 body 二进制数据
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", resolve);
    req.on("error", reject);
  });
  const audioBuffer = Buffer.concat(chunks);

  if (!audioBuffer.length) return res.status(400).json({ error: "empty_file" });
  if (audioBuffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: "file_too_large" }); // 20MB 上限

  // R2 路径：user_id/clip_id/segment_idx.webm
  const ext = mime.includes("mp4") ? "mp4" : "webm";
  const filePath = `${user.id}/${clip_id}/${segment_idx}.${ext}`;

  try {
    const s3 = getS3();
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: filePath,
      Body: audioBuffer,
      ContentType: mime,
    }));
  } catch (e) {
    console.error("[recording_save] R2 upload error:", e.message);
    return res.status(502).json({ error: "r2_upload_failed", detail: e.message });
  }

  // 写入 / 覆盖数据库记录（upsert）
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.from("recordings").upsert({
    user_id: user.id,
    clip_id,
    segment_idx,
    file_path: filePath,
    duration_sec,
  }, { onConflict: "user_id,clip_id,segment_idx" }).select("id").single();

  if (error) {
    console.error("[recording_save] db error:", error.message);
    return res.status(500).json({ error: "db_failed", detail: error.message });
  }

  return res.status(200).json({ ok: true, id: data.id, file_path: filePath });
};
