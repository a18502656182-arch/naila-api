// api/site_config.js
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ADMIN_EMAILS = ["214895399@qq.com"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { key } = req.query;
    if (!key) return res.json({ error: "missing key" });
    const { data } = await supabase
      .from("site_config")
      .select("value")
      .eq("key", key)
      .single();
    return res.json({ value: data?.value ?? null });
  }

  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "unauthorized" });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user || !ADMIN_EMAILS.includes(user.email)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "missing key" });

    const { error } = await supabase
      .from("site_config")
      .upsert({ key, value }, { onConflict: "key" });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
};
