// api/proxy_video.js
// GET /api/proxy_video?url=<encoded_url>
// 反代 HLS 视频：
//   - 请求 m3u8 时，重写内容里的分片路径为 /api/proxy_video?url=... 形式
//   - 请求 ts/m4s 分片时，直接透传二进制流

const https = require("https");
const http = require("http");
const { URL } = require("url");

// 只允许反代这些域名，防止被滥用为任意反代
const ALLOWED_HOSTS = [
  "customer-",        // Cloudflare Stream 子域
  "videodelivery.net",
  "cloudflarestream.com",
  "stream.cloudflare.com",
  "r2.cloudflarestorage.com",
];

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return ALLOWED_HOSTS.some(h => u.hostname.includes(h));
  } catch {
    return false;
  }
}

function fetchRaw(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      { hostname: u.hostname, path: u.pathname + u.search, headers, method: "GET" },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const rawUrl = req.query?.url;
  if (!rawUrl) return res.status(400).json({ error: "missing url" });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl); // 验证格式
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  if (!isAllowed(targetUrl)) {
    return res.status(403).json({ error: "domain not allowed" });
  }

  try {
    const upstream = await fetchRaw(targetUrl, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    });

    const status = upstream.statusCode || 502;
    const contentType = upstream.headers["content-type"] || "";

    // 判断是否是 m3u8 文件
    const isM3u8 =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      targetUrl.includes(".m3u8");

    if (isM3u8) {
      // 读取完整 m3u8 文本内容
      let body = "";
      await new Promise((resolve, reject) => {
        upstream.setEncoding("utf8");
        upstream.on("data", chunk => { body += chunk; });
        upstream.on("end", resolve);
        upstream.on("error", reject);
      });

      // 计算 m3u8 的 base URL（用于解析相对路径）
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

      // 重写 m3u8 内容：把所有分片路径替换成 /api/proxy_video?url=...
      const rewritten = body.split("\n").map(line => {
        const trimmed = line.trim();
        // 跳过空行和注释（但 #EXT-X-KEY URI= 需要处理）
        if (!trimmed) return line;

        // 处理 #EXT-X-KEY URI="..."
        if (trimmed.startsWith("#EXT-X-KEY")) {
          return line.replace(/URI="([^"]+)"/, (_, uri) => {
            const abs = uri.startsWith("http") ? uri : baseUrl + uri;
            return `URI="/api/proxy_video?url=${encodeURIComponent(abs)}"`;
          });
        }

        // 跳过其他注释行
        if (trimmed.startsWith("#")) return line;

        // 这是一个分片路径（.ts / .m4s / .m3u8 子列表）
        const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
        return `/api/proxy_video?url=${encodeURIComponent(abs)}`;
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=10");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(status).send(rewritten);
    }

    // 非 m3u8：直接透传二进制（ts 分片、init segment 等）
    res.setHeader("Content-Type", contentType || "video/MP2T");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"]);
    }
    res.status(status);
    upstream.pipe(res);
  } catch (e) {
    console.error("[proxy_video] error:", e.message);
    return res.status(502).json({ error: "upstream_failed", detail: e.message });
  }
};
