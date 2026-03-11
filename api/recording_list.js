// api/recording_list.js
// GET /api/recording_list?clip_id=xxx
// 返回该用户在此 clip 的所有录音，附带 R2 presigned URL（1小时有效）

const { createClient } = require("@supabase/supabase-js");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData } = await anon.auth.getUser(token);
  const user = userData?.user;
  if (!user) return res.status(401).json({ error: "invalid_token" });

  const clip_id = Number(req.query.clip_id);
  if (!clip_id) return res.status(400).json({ error: "missing clip_id" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rows, error } = await admin
    .from("recordings")
    .select("id, segment_idx, file_path, duration_sec, created_at")
    .eq("user_id", user.id)
    .eq("clip_id", clip_id);

  if (error) return res.status(500).json({ error: "db_failed", detail: error.message });
  if (!rows || rows.length === 0) return res.status(200).json({ ok: true, recordings: [] });

  // 为每条录音生成 presigned URL（1小时）
  const s3 = getS3();
  const recordings = await Promise.all(rows.map(async row => {
    try {
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: row.file_path,
      }), { expiresIn: 3600 });
      return { ...row, url };
    } catch {
      return { ...row, url: null };
    }
  }));

  return res.status(200).json({ ok: true, recordings });
};
