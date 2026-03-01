const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "2mb" }));

const ALLOW_ORIGINS = [
  "https://www.nailaobao.top",
  "https://nailaobao.top",
  "https://naila-clips-eo9w.vercel.app",
];

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);
app.options("*", cors());

// 挂载 Next API 迁移版
function mount(name) {
  const handler = require(`./api/${name}.js`);
  app.all(`/api/${name}`, (req, res) => handler(req, res));
}

mount("me");
mount("clips");
mount("bookmarks_list_ids");
mount("bookmarks_add");
mount("bookmarks_delete");
app.all("/rsc-api/clips", (req, res) => require("./rsc-api/clips.js")(req, res));
app.all("/rsc-api/taxonomies", (req, res) => require("./rsc-api/taxonomies.js")(req, res));

app.get("/", (req, res) => res.send("naila-api ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on", port));


