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
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
  // .bib / .sty / .cls 也走 LaTeX 專案：它們本身不是主檔，但改了要重編，
  // 而且檔案樹本來就把它們列出來了——列了卻打不開很怪。
  if (/\.(tex|bib|sty|cls)$/i.test(file)) return texCtx(file);
  throw new Error("只能編輯 .html / .tex / .bib / .sty / .cls");
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

// SyncTeX 把整個段落標在 \par 的位置，而 \par 通常就是段落後面那個空行。
// 直接跳過去會停在一行空白上，看起來像壞掉。往上退到最近的有內容的行，
// 也就是該段落的最後一行——這是 SyncTeX 的粒度能給的最好結果。
function snapToContent(file, line) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let i = Math.min(line, lines.length) - 1;
    while (i > 0 && !lines[i].trim()) i--;
    return i + 1;
  } catch (e) {
    return line;
  }
}

const VENDOR = {
  "pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
  "xterm.js": "@xterm/xterm/lib/xterm.js",
  "xterm.css": "@xterm/xterm/css/xterm.css",
  "addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
};

// 走訪專案目錄收集可編輯的檔案。深度限 3 層，夠涵蓋 sections/、figures/ 這種結構，
// 又不會在誤開家目錄之類的地方掃到天荒地老。
const SKIP = new Set([".bifold", ".git", "node_modules", ".build-pptx", "rendered"]);
function walk(root, exts, dir = root, depth = 0, out = []) {
  if (depth > 3 || out.length > 500) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, exts, full, depth + 1, out);
    else if (exts.test(e.name)) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out.sort();
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/") return send(res, 200, MIME[".html"], fs.readFileSync(path.join(__dirname, "ui.html")));

  // 前端用得到的第三方檔案直接從 node_modules 供應，不需要打包工具。
  // 白名單而不是任意路徑：/vendor/ 底下能拿到什麼，這裡說了算。
  if (p.startsWith("/vendor/")) {
    const rel = VENDOR[path.basename(p)];
    if (!rel) return send(res, 404, "text/plain", "not found");
    const f = path.join(__dirname, "..", "node_modules", rel);
    if (!fs.existsSync(f)) return send(res, 404, "text/plain", "缺少依賴，請先 npm install");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(f).toLowerCase()] || MIME[".js"],
      "Cache-Control": "max-age=86400",
    });
    return fs.createReadStream(f).pipe(res);
  }
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

  // 原生選檔對話框。瀏覽器的 <input type="file"> 拿不到絕對路徑（安全限制），
  // 而這個工具就是靠絕對路徑讀寫真實檔案的，所以只能請 macOS 出面。
  //
  // 用 NSOpenPanel 而不是 AppleScript 的 choose file / choose folder：
  // 那兩個是不同指令，會逼使用者在按下按鈕之前就先決定「我要選檔還是選資料夾」。
  // NSOpenPanel 兩種都收，一顆按鈕就夠。
  if (p === "/pick") {
    const script = `
ObjC.import("AppKit");
const panel = $.NSOpenPanel.openPanel;
panel.canChooseFiles = true;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = false;
panel.message = "選擇 .tex / .html 檔，或整個專案資料夾";
panel.prompt = "開啟";
$.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
panel.runModal === 1 ? ObjC.unwrap(panel.URL.path) : ""
`;
    return execFile("osascript", ["-l", "JavaScript", "-e", script],
      { timeout: 600000 }, (err, stdout) => {
        if (err) return json(res, 200, { ok: false });
        let picked = (stdout || "").trim().replace(/\/$/, "");
        if (!picked) return json(res, 200, { ok: false });   // 按了取消

        try {
          if (fs.statSync(picked).isDirectory()) {
            // 資料夾本身不能編輯，挑一個主檔進去。挑不到就讓前端說明白。
            const cands = walk(picked, /\.(tex|html?)$/i);
            const best = cands.find((f) => /^(main|paper|thesis|index)\.(tex|html?)$/i.test(f))
              || cands.find((f) => f.endsWith(".tex")
                   && latex.findMain(path.join(picked, f)) === path.join(picked, f))
              || cands[0];
            if (!best) return json(res, 200, { ok: false, error: "這個資料夾裡沒有 .tex 或 .html" });
            picked = path.join(picked, best);
          } else if (!/\.(tex|bib|sty|cls|html?)$/i.test(picked)) {
            return json(res, 200, { ok: false, error: "只能開 .tex / .bib / .sty / .cls / .html" });
          }
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message });
        }
        json(res, 200, { ok: true, path: picked });
      });
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
    // 要給 Content-Length。少了它會走 chunked，瀏覽器內建的 PDF viewer
    // 遇到 chunked 有時就整片空白，不報錯也不畫東西，很難查。
    res.writeHead(200, {
      "Content-Type": MIME[".pdf"],
      "Content-Length": fs.statSync(lastBuild.pdf).size,
      "Cache-Control": "no-store",
    });
    return fs.createReadStream(lastBuild.pdf).pipe(res);
  }

  // 新增檔案。只做新增，不做刪除與改名——那兩個 Finder 做更安全，
  // 而這個工具的定位是微調成品，不是檔案管理器。
  if (p === "/new" && req.method === "POST") {
    try {
      const rel = (JSON.parse(await readBody(req)).name || "").trim();
      if (!rel) return json(res, 200, { ok: false, error: "要給檔名" });
      const target = path.resolve(cur.root, rel);
      // 不准跳出專案資料夾
      if (target !== cur.root && !target.startsWith(cur.root + path.sep))
        return json(res, 200, { ok: false, error: "只能建在專案資料夾裡" });
      if (!/\.(tex|bib|sty|cls|html?)$/i.test(target))
        return json(res, 200, { ok: false, error: "副檔名要是 .tex / .bib / .sty / .cls / .html" });
      if (fs.existsSync(target)) return json(res, 200, { ok: false, error: "這個檔案已經存在" });

      fs.mkdirSync(path.dirname(target), { recursive: true });
      // .tex 給一行 \section 起頭，省得開了是全空的還要想從哪寫
      const seed = /\.tex$/i.test(target)
        ? "\\section{" + path.basename(target).replace(/\.tex$/i, "") + "}\n\n"
        : "";
      fs.writeFileSync(target, seed, "utf8");
      return json(res, 200, { ok: true, path: target });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  // 專案檔案樹。論文是多檔案的，要切檔卻得手動貼絕對路徑，這件事很煩。
  if (p === "/tree") {
    const exts = cur.kind === "tex" ? /\.(tex|bib|sty|cls)$/i : /\.html?$/i;
    return json(res, 200, { root: cur.root, files: walk(cur.root, exts) });
  }

  // 點了 PDF 第 page 頁的 (x, y)（單位 pt）→ 是原始碼哪一檔的哪一行
  if (p === "/rsync") {
    const r = synctex.reverse(sxIndex,
      +url.searchParams.get("page") || 1,
      +url.searchParams.get("x") || 0,
      +url.searchParams.get("y") || 0);
    if (r) r.line = snapToContent(r.file, r.line);
    return json(res, 200, r || {});
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
});

// ── 終端機 ────────────────────────────────────────
// 真的開一個 pty 跑使用者自己的 shell，不是模擬幾個指令——
// 這樣 tectonic、git、claude 這些原本就在用的東西全都直接能用。
//
// 只綁 127.0.0.1。這條通道等同於本機 shell 存取，絕不能對外開。
function attachTerminal(server) {
  let pty, WebSocketServer;
  try {
    pty = require("node-pty");
    ({ WebSocketServer } = require("ws"));
  } catch (e) {
    console.log("終端機停用（缺 node-pty 或 ws，執行 npm install 即可）");
    return;
  }

  const wss = new WebSocketServer({ server, path: "/term" });
  wss.on("connection", (sock) => {
    let term;
    try {
      term = pty.spawn(process.env.SHELL || "/bin/zsh", [], {
        name: "xterm-color", cols: 80, rows: 24,
        cwd: cur ? cur.root : process.env.HOME,
        env: process.env,
      });
    } catch (e) {
      // node-pty 的 prebuilt spawn-helper 常常沒有執行權限，訊息會是 posix_spawnp failed
      sock.send("\r\n\x1b[31m無法開啟終端機：" + e.message +
        "\r\n若是 posix_spawnp failed，執行 npm run fix-pty\x1b[0m\r\n");
      return sock.close();
    }

    term.onData((d) => { if (sock.readyState === 1) sock.send(d); });
    term.onExit(() => { try { sock.close(); } catch (e) {} });

    sock.on("message", (m) => {
      const s = m.toString();
      // \x00 開頭是改變視窗大小，其餘一律當成鍵盤輸入
      if (s[0] === "\x00") {
        const [c, r] = s.slice(1).split(",").map(Number);
        if (c > 0 && r > 0) { try { term.resize(c, r); } catch (e) {} }
      } else {
        term.write(s);
      }
    });
    sock.on("close", () => { try { term.kill(); } catch (e) {} });
  });
}

attachTerminal(server);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`bifold  http://127.0.0.1:${PORT}`);
  if (cur) {
    console.log(`編輯中  ${cur.file}`);
    if (cur.kind === "tex" && cur.main !== cur.file) console.log(`編譯    ${cur.main}`);
  } else {
    console.log("尚未指定檔案，開啟網頁後貼上絕對路徑");
  }
});
