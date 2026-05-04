// api/proxy_video.js
const https = require("https");
const http = require("http");
const { URL } = require("url");

const ALLOWED_HOSTS = [
  "customer-",
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

// 把任意 URI（相对或绝对）转成反代路径
function proxyUri(uri, baseUrl) {
  const abs = uri.startsWith("http") ? uri : baseUrl + uri;
  return `/api/proxy_video?url=${encodeURIComponent(abs)}`;
}

module.exports = async function handler(req, res) {
  const rawUrl = req.query?.url;
  if (!rawUrl) return res.status(400).json({ error: "missing url" });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl);
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

    const isM3u8 =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      targetUrl.includes(".m3u8");

    if (isM3u8) {
      let body = "";
      await new Promise((resolve, reject) => {
        upstream.setEncoding("utf8");
        upstream.on("data", chunk => { body += chunk; });
        upstream.on("end", resolve);
        upstream.on("error", reject);
      });

      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

      // 过滤掉 1080p，只保留 720p 以下，节省 Egress 流量
      // 策略：遇到 1080p 的 #EXT-X-STREAM-INF 行，连同下一行的 URI 一起跳过
      const lines = body.split("\n");
      const filteredLines = [];
      let skipNext = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (line.includes("RESOLUTION=1920x1080") || line.includes("RESOLUTION=2560x1440") || line.includes("RESOLUTION=3840x2160")) {
          skipNext = true;
          continue;
        }
        filteredLines.push(line);
      }
      const filteredBody = filteredLines.join("\n");

      const rewritten = filteredBody.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // 处理所有带 URI="..." 的标签行（#EXT-X-KEY、#EXT-X-MEDIA、#EXT-X-I-FRAME-STREAM-INF 等）
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            return `URI="${proxyUri(uri, baseUrl)}"`;
          });
        }

        // 跳过其他注释行
        if (trimmed.startsWith("#")) return line;

        // 分片路径（.ts / .m4s / .m3u8 子列表）
        return proxyUri(trimmed, baseUrl);
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=10");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(status).send(rewritten);
    }

    // 非 m3u8：透传二进制
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
