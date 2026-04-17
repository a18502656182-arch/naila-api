// server.js（稳定版：任何路由文件缺失也不会导致服务崩溃）
const express = require("express");
const cors = require("cors");
const app = express();
app.use(express.json({ limit: "20mb" }));

const ALLOW_ORIGINS = [
  "https://www.nailaobao.top",
  "https://nailaobao.top",
];

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (/\.vercel\.app$/.test(origin)) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.options("*", (req, res) => res.sendStatus(204));
app.get("/", (req, res) => res.send("naila-api ok"));

function mountApi(name) {
  app.all(`/api/${name}`, async (req, res) => {
    try {
      const handler = require(`./api/${name}.js`);
      return handler(req, res);
    } catch (e) {
      return res.status(500).json({
        error: "handler_load_failed",
        route: `/api/${name}`,
        detail: String(e?.message || e),
      });
    }
  });
}

function mountRsc(route, file) {
  app.all(route, async (req, res) => {
    try {
      const handler = require(file);
      return handler(req, res);
    } catch (e) {
      return res.status(500).json({
        error: "handler_load_failed",
        route,
        file,
        detail: String(e?.message || e),
      });
    }
  });
}

mountApi("me");
mountApi("clips");
mountApi("bookmarks_list_ids");
mountApi("bookmarks_add");
mountApi("bookmarks_delete");
mountApi("bookmarks");
mountApi("clip_full");
mountApi("bookmarks_has");
mountApi("vocab_fav_add");
mountApi("vocab_fav_delete");
mountApi("vocab_favorites");
mountApi("vocab_update_mastery");
mountApi("view_log");
mountApi("journal_stats");
mountApi("game_scores");
mountApi("redeem");
mountApi("register");
mountApi("dictation_upsert");
mountApi("dictation_list");
mountApi("proxy_video");
mountApi("recording_save");
mountApi("recording_list");
mountApi("recording_delete");

// ── 支付相关 ──
mountApi("pay_create");
mountApi("pay_notify");
mountApi("pay_query");
mountApi("site_config");

mountRsc("/rsc-api/clips", "./rsc-api/clips.js");
mountRsc("/rsc-api/taxonomies", "./rsc-api/taxonomies.js");

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on", port));
