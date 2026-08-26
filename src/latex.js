// LaTeX 編譯：用 Tectonic 把 .tex 編成 PDF。
//
// 選 Tectonic 而不是 MacTeX 的理由：單一 binary，缺什麼 package 自己抓，
// 不必手動 tlmgr install 追缺件。代價是第一次編譯要等它下載（實測 30 秒到
// 3 分鐘，看用到多少新 package），之後 cache 全熱大約 0.8 秒。
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const OUTDIR = ".bifold";           // 編譯產物都丟這，方便 gitignore
const MAIN_NAMES = ["main.tex", "paper.tex", "thesis.tex", "index.tex"];

const hasPreamble = (f) => {
  try {
    // 只讀前 8KB，論文的 \documentclass 一定在最前面，不必整份讀進來
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    return /\\documentclass/.test(buf.slice(0, n).toString("utf8"));
  } catch (e) {
    return false;
  }
};

// 決定要編哪個檔。論文不是單一檔案——你可能正在編 sections/intro.tex，
// 但要編譯的永遠是 main.tex，否則預覽會是一份沒有 preamble 的殘骸。
function findMain(file) {
  file = path.resolve(file);
  if (hasPreamble(file)) return file;             // 自己就是主檔

  for (let d = path.dirname(file), i = 0; i < 3; i++, d = path.dirname(d)) {
    for (const n of MAIN_NAMES) {
      const c = path.join(d, n);
      if (fs.existsSync(c) && hasPreamble(c)) return c;
    }
    // 沒有慣用檔名就掃這層目錄，找唯一一個有 preamble 的 .tex
    let found = null, many = false;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".tex")) continue;
      const c = path.join(d, f);
      if (!hasPreamble(c)) continue;
      if (found) many = true; else found = c;
    }
    if (found && !many) return found;
    if (path.dirname(d) === d) break;
  }
  return file; // 找不到就編自己，讓 TeX 自己報錯，比默默編錯檔好
}

// 從 TeX log 裡撈出第一個真正的錯誤。
// log 動輒上千行，全部丟給使用者等於沒給。
function firstError(log) {
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] !== "!") continue;
    const msg = lines[i].replace(/^!\s*/, "").trim();
    // 錯誤訊息下面幾行裡的 "l.123" 是出錯行號
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      const m = /^l\.(\d+)/.exec(lines[j]);
      if (m) return { msg, line: +m[1] };
    }
    return { msg, line: null };
  }
  return null;
}

function compile(main, cb) {
  const root = path.dirname(main);
  const outdir = path.join(root, OUTDIR);
  fs.mkdirSync(outdir, { recursive: true });

  const args = ["-X", "compile", "--outdir", outdir, "--synctex", "--keep-logs", main];

  execFile("tectonic", args, { cwd: root, timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const log = (stdout || "") + (stderr || "");
      const base = path.basename(main).replace(/\.tex$/i, "");
      const pdf = path.join(outdir, base + ".pdf");
      const ok = fs.existsSync(pdf) && !err;

      if (err && /ENOENT/.test(err.code || "")) {
        return cb({ ok: false, log: "找不到 tectonic。請先 brew install tectonic。", pdf: null });
      }
      cb({
        ok,
        log,
        error: ok ? null : firstError(log),
        pdf: ok ? pdf : null,
        synctex: path.join(outdir, base + ".synctex.gz"),
      });
    });
}

module.exports = { compile, findMain, OUTDIR };
