#!/usr/bin/env node
// bifold：左邊原始碼、右邊即時預覽，改完 ⌘S 直接寫回硬碟上的真實檔案。
// 不做副本，所以永遠不會有兩份來源分岔的問題。
//
//   node src/server.js [port] [要編輯的檔案絕對路徑]
//
// 支援兩種來源：
//   .html — 預覽即成品，可點選定位、拖邊界改間距、匯出 PPTX
//   .tex  — 用 Tectonic 編成 PDF，游標移動時 PDF 自動跳到對應頁
//
// 啟動後也可以在網頁上輸入其他檔案的絕對路徑切換過去。
//
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const latex = require("./latex");
const synctex = require("./synctex");

const PORT = +process.argv[2] || 8790;
const DEFAULT = process.argv[3] || "";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp4": "video/mp4",
  ".m4a": "audio/mp4", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// 專案根 = 往上最多三層找得到 build-pptx.sh 的地方；找不到就用檔案所在目錄。
// 這樣 deck.html 在 html/ 底下也能吃到上一層的建置腳本與 ../assets。
function htmlCtx(file) {
  let root = path.dirname(file), build = null;
  for (let d = path.dirname(file), i = 0; i < 3; i++, d = path.dirname(d)) {
    const s = path.join(d, "build-pptx.sh");
    if (fs.existsSync(s)) { root = d; build = s; break; }
  }
  const pptx = build
    ? (fs.readdirSync(root).find((f) => f.endsWith(".pptx") && !f.startsWith("~$")) || null)
    : null;

  return {
    kind: "html", file, root, build,
    pptx: pptx ? path.join(root, pptx) : null,
    previewUrl: "/preview/" + path.relative(root, file).split(path.sep).join("/"),
  };
}

// 論文多半是 main.tex + sections/*.tex。編輯的可能是任一個子檔，
// 但要編譯的永遠是主檔，否則預覽會是一份沒有 preamble 的殘骸。
function texCtx(file) {
  const main = latex.findMain(file);
  return {
    kind: "tex", file, main,
    root: path.dirname(main),
    build: null, pptx: null,
    previewUrl: "/pdf",
  };
}

function makeCtx(file) {
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error("找不到檔案：" + file);
  if (/\.html?$/i.test(file)) return htmlCtx(file);
  if (/\.tex$/i.test(file)) return texCtx(file);
  throw new Error("只能編輯 .html 或 .tex 檔");
}

let cur = DEFAULT ? makeCtx(DEFAULT) : null;
let lastBuild = null;   // 最近一次 LaTeX 編譯結果
let sxIndex = null;     // 最近一次的 SyncTeX 索引

// 預覽版才注入：每個開標籤掛上原始行號與序號。
// 序號讓「同一行有多個標籤」也能精準定位——寫回時前端用同一組規則數到第 N 個。
// <style> 區塊要跳過，否則 CSS 會被寫壞。
const TAGS = /<(div|section|p|h1|h2|h3|h4|span|b|i|em|small|li|td|th|a|pre|code)\b/gi;
function injectMarkers(src) {
  let inStyle = false, n = 0;
  const body = src.split("\n").map((line, i) => {
    if (/<style\b/i.test(line)) inStyle = true;
    if (inStyle) {
      if (/<\/style>/i.test(line)) inStyle = false;
      return line;
    }
    return line.replace(TAGS, (m, tag) => `<${tag} data-l="${i + 1}" data-i="${n++}"`);
  }).join("\n");

  const probe = `
<script>
${fs.readFileSync(path.join(__dirname, "probe.js"), "utf8")}
</script>`;
  return body.includes("</body>") ? body.replace("</body>", probe + "\n</body>") : body + probe;
}

const send = (res, code, type, data) => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
};
const json = (res, code, obj) => send(res, code, MIME[".json"], JSON.stringify(obj));
const readBody = (req) =>
  new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });

const state = () => cur && ({
  kind: cur.kind,
  file: cur.file, name: path.basename(cur.file),
  previewUrl: cur.previewUrl,
  hasBuild: !!cur.build, hasPptx: !!cur.pptx,
  // 編輯子檔時要讓使用者知道實際編譯的是哪一份
  main: cur.kind === "tex" ? path.basename(cur.main) : null,
  isMain: cur.kind === "tex" ? cur.main === cur.file : null,
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/") return send(res, 200, MIME[".html"], fs.readFileSync(path.join(__dirname, "ui.html")));
  if (p === "/state") return json(res, 200, state() || { kind: null });

  // 切換要編輯的檔案
  if (p === "/open" && req.method === "POST") {
    try {
      cur = makeCtx(JSON.parse(await readBody(req)).path.trim().replace(/^file:\/\//, ""));
      lastBuild = null; sxIndex = null;
      return json(res, 200, { ok: true, ...state() });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (!cur) return send(res, 404, "text/plain", "尚未開啟任何檔案");

  // 原始碼讀寫
  if (p === "/file" && req.method === "GET")
    return send(res, 200, "text/plain; charset=utf-8", fs.readFileSync(cur.file, "utf8"));
  if (p === "/file" && req.method === "POST") {
    const body = await readBody(req);
    fs.writeFileSync(cur.file, body, "utf8");
    return json(res, 200, { ok: true, bytes: Buffer.byteLength(body) });
  }

  // ── LaTeX ──────────────────────────────────────
  // 編譯主檔。cache 全熱時約 0.8 秒；第一次會慢很多，因為 Tectonic 在抓 package。
  if (p === "/compile" && req.method === "POST") {
    if (cur.kind !== "tex") return json(res, 400, { ok: false, log: "這不是 .tex 檔" });
    return latex.compile(cur.main, (r) => {
      lastBuild = r;
      sxIndex = r.ok ? synctex.parse(r.synctex) : sxIndex; // 編譯失敗就沿用舊索引
      json(res, 200, { ok: r.ok, error: r.error, log: r.log.slice(-4000) });
    });
  }

  if (p === "/pdf") {
    if (!lastBuild || !lastBuild.pdf || !fs.existsSync(lastBuild.pdf))
      return send(res, 404, "text/plain", "尚未編譯");
    res.writeHead(200, { "Content-Type": MIME[".pdf"], "Cache-Control": "no-store" });
    return fs.createReadStream(lastBuild.pdf).pipe(res);
  }

  // 游標在第幾行 → PDF 該跳第幾頁
  if (p === "/page") {
    const line = +url.searchParams.get("line") || 1;
    return json(res, 200, { page: synctex.pageOf(sxIndex, cur.file, line) });
  }

  // ── PPTX（只有 HTML 專案有）────────────────────
  // 呼叫專案既有的 build-pptx.sh，維持單一建置路徑
  if (p === "/build" && req.method === "POST") {
    if (!cur.build) return json(res, 400, { ok: false, out: "這個專案沒有 build-pptx.sh" });
    return execFile(cur.build, { cwd: cur.root, timeout: 300000 }, (err, stdout, stderr) => {
      if (!err) cur = makeCtx(cur.file); // 重新抓 pptx 檔名
      json(res, err ? 500 : 200, { ok: !err, out: (stdout || "") + (stderr || "") });
    });
  }

  if (p === "/pptx") {
    if (!cur.pptx || !fs.existsSync(cur.pptx)) return send(res, 404, "text/plain", "尚未建置");
    res.writeHead(200, {
      "Content-Type": MIME[".pptx"],
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(cur.pptx)),
    });
    return fs.createReadStream(cur.pptx).pipe(res);
  }

  // 預覽：目標檔走注入版，其餘資源（圖、影片）原樣提供
  if (p.startsWith("/preview/")) {
    const file = path.join(cur.root, p.slice("/preview/".length));
    if (!file.startsWith(cur.root) || !fs.existsSync(file)) return send(res, 404, "text/plain", "not found");
    if (path.resolve(file) === cur.file)
      return send(res, 200, MIME[".html"], injectMarkers(fs.readFileSync(file, "utf8")));
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    return fs.createReadStream(file).pipe(res);
  }

  send(res, 404, "text/plain", "not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`bifold  http://127.0.0.1:${PORT}`);
  if (cur) {
    console.log(`編輯中  ${cur.file}`);
    if (cur.kind === "tex" && cur.main !== cur.file) console.log(`編譯    ${cur.main}`);
  } else {
    console.log("尚未指定檔案，開啟網頁後貼上絕對路徑");
  }
});
