// api/pay_notify.js
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ZPAY_KEY = process.env.ZPAY_KEY || "p9AmtnMaUTjFlid4mWqokSby12PiyZCf";

function zpaySign(params) {
  const keys = Object.keys(params)
    .filter(k => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== null && params[k] !== undefined)
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join("&") + ZPAY_KEY;
  return crypto.createHash("md5").update(str).digest("hex");
}

module.exports = async function handler(req, res) {
  // zpay 回调用 GET 或 POST，兼容两种
  const params = req.method === "POST" ? req.body : req.query;

  const { trade_no, out_trade_no, trade_status, money, sign, pid } = params;

  // 1. 验证签名
  const paramsToSign = { ...params };
  delete paramsToSign.sign;
  delete paramsToSign.sign_type;
  const expectedSign = zpaySign(paramsToSign);
  if (sign !== expectedSign) {
    console.error("[pay_notify] 签名验证失败", { sign, expectedSign });
    return res.status(200).send("fail"); // zpay 要求返回 fail 表示验证失败
  }

  // 2. 只处理支付成功的回调
  if (trade_status !== "TRADE_SUCCESS") {
    return res.status(200).send("success");
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 3. 查订单
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("*")
    .eq("out_trade_no", String(out_trade_no))
    .maybeSingle();

  if (orderErr || !order) {
    console.error("[pay_notify] 订单不存在", out_trade_no);
    return res.status(200).send("fail");
  }

  // 4. 防止重复处理
  if (order.status === "paid") {
    return res.status(200).send("success");
  }

  // 5. 更新订单状态
  const { error: updateOrderErr } = await admin
    .from("orders")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("out_trade_no", String(out_trade_no));

  if (updateOrderErr) {
    console.error("[pay_notify] 更新订单失败", updateOrderErr.message);
    return res.status(200).send("fail");
  }

  // 6. 激活兑换码
  const { error: activateErr } = await admin
    .from("redeem_codes")
    .update({ is_active: true })
    .eq("code", order.redeem_code);

  if (activateErr) {
    console.error("[pay_notify] 激活兑换码失败", activateErr.message);
    return res.status(200).send("fail");
  }

  console.log("[pay_notify] 支付成功，兑换码已激活", {
    out_trade_no,
    trade_no,
    redeem_code: order.redeem_code,
    plan: order.plan,
    amount: money,
  });

  // zpay 要求返回 success 表示处理成功
  return res.status(200).send("success");
};
