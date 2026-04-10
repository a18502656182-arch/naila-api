// api/register.js（Railway 后端，CommonJS）
const { createClient } = require("@supabase/supabase-js");

function isEmailLike(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}
function normalizeUsername(s) {
  const raw = String(s || "").trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned.slice(0, 32);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { identifier, password, code } = req.body || {};

    if (!identifier) return res.status(400).json({ error: "identifier_required" });
    if (!password || password.length < 8) return res.status(400).json({ error: "password_too_short" });
    if (!code) return res.status(400).json({ error: "code_required" });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      return res.status(500).json({ error: "Server config error" });
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let email = null;
    let username = null;
    const trimmedCode = String(code).trim();

    if (isEmailLike(identifier)) {
      email = String(identifier).trim().toLowerCase();
    } else {
      username = normalizeUsername(identifier);
      if (!username) return res.status(400).json({ error: "identifier_required" });
      email = `${username}@users.nailaobao.local`;
    }

    // 0) 提前验证兑换码
    const { data: rc, error: rcErr } = await admin
      .from("redeem_codes")
      .select("code, plan, days, max_uses, used_count, expires_at, is_active")
      .eq("code", trimmedCode)
      .maybeSingle();

    if (rcErr) return res.status(500).json({ error: "db_read_failed" });
    if (!rc || !rc.is_active) return res.status(400).json({ error: "invalid_code" });
    if (rc.expires_at && new Date(rc.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "code_expired" });
    }
    const used = Number(rc.used_count || 0);
    const max = Number(rc.max_uses || 0);
    if (max > 0 && used >= max) return res.status(400).json({ error: "code_used_up" });

    // 1) 检查用户名是否重复
    if (!isEmailLike(identifier)) {
      const { data: existingProfile } = await admin
        .from("profiles")
        .select("user_id")
        .eq("username", username)
        .maybeSingle();
      if (existingProfile) return res.status(400).json({ error: "username_exists" });
    }

    // 2) 创建用户
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: username ? { username } : {},
    });
    if (createErr) {
      if (createErr.message?.includes("already")) return res.status(400).json({ error: "email_exists" });
      return res.status(400).json({ error: createErr.message });
    }

    const userId = created?.user?.id;
    if (!userId) return res.status(500).json({ error: "Create user failed (no user id)" });

    // 3) 写 profiles（记录 used_code）
    const profileRow = { user_id: userId, used_code: trimmedCode };
    if (username) profileRow.username = username;
    // 试用卡：标记已使用，防止注册后再用试用卡叠加
    if (rc.plan === "trial") profileRow.used_trial = true;

    const { error: profErr } = await admin.from("profiles").insert(profileRow);
    if (profErr) {
      if (username) {
        await admin.auth.admin.deleteUser(userId);
        return res.status(400).json({ error: "username_exists" });
      }
      console.error("profiles insert error:", profErr.message);
    }

    // 4) 执行兑换码 RPC
    const { data: redeemed, error: redeemErr } = await admin.rpc("redeem_code", {
      p_code: trimmedCode,
      p_user_id: userId,
    });
    if (redeemErr) {
      await admin.auth.admin.deleteUser(userId);
      return res.status(400).json({ error: redeemErr.message });
    }

    // 5) 自动登录拿 token
    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signed, error: signErr } = await anon.auth.signInWithPassword({ email, password });

    if (signErr || !signed?.session) {
      return res.status(200).json({
        ok: true,
        needs_login: true,
        email: email,
        plan: redeemed?.[0]?.plan ?? null,
        expires_at: redeemed?.[0]?.expires_at ?? null,
      });
    }

    return res.status(200).json({
      ok: true,
      needs_login: false,
      email: email,
      access_token: signed.session.access_token,
      refresh_token: signed.session.refresh_token,
      expires_at: redeemed?.[0]?.expires_at !== undefined ? redeemed?.[0]?.expires_at : null,
      plan: redeemed?.[0]?.plan ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
};
