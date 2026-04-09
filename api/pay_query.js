// api/pay_query.js
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const out_trade_no = req.query.order;
  if (!out_trade_no) return res.status(400).json({ error: "missing_order" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: order, error } = await admin
    .from("orders")
    .select("out_trade_no, plan, days, amount, status, redeem_code, created_at, paid_at")
    .eq("out_trade_no", String(out_trade_no))
    .maybeSingle();

  if (error || !order) return res.status(404).json({ error: "order_not_found" });

  return res.status(200).json({
    ok: true,
    status: order.status,
    plan: order.plan,
    days: order.days,
    amount: order.amount,
    // 只有支付成功才返回兑换码
    redeem_code: order.status === "paid" ? order.redeem_code : null,
    created_at: order.created_at,
    paid_at: order.paid_at,
  });
};
