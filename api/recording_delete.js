// api/recording_delete.js
// POST /api/recording_delete
// Body: { clip_id, segment_idx }

const { createClient } = require("@supabase/supabase-js");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

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

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData } = await anon.auth.getUser(token);
  const user = userData?.user;
  if (!user) return res.status(401).json({ error: "invalid_token" });

  const clip_id = Number(req.body?.clip_id);
  const segment_idx = Number(req.body?.segment_idx ?? -1);
  if (!clip_id || segment_idx < 0) return res.status(400).json({ error: "missing params" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 先查出 file_path
  const { data: row } = await admin
    .from("recordings")
    .select("file_path")
    .eq("user_id", user.id)
    .eq("clip_id", clip_id)
    .eq("segment_idx", segment_idx)
    .maybeSingle();

  if (row?.file_path) {
    // 删 R2 文件（失败不阻断流程）
    try {
      const s3 = getS3();
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.file_path }));
    } catch (e) {
      console.error("[recording_delete] R2 delete error:", e.message);
    }
  }

  // 删数据库记录
  const { error } = await admin
    .from("recordings")
    .delete()
    .eq("user_id", user.id)
    .eq("clip_id", clip_id)
    .eq("segment_idx", segment_idx);

  if (error) return res.status(500).json({ error: "db_failed", detail: error.message });

  return res.status(200).json({ ok: true });
};
