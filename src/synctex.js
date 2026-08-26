// SyncTeX 解析：把「原始碼第幾行」對應到「PDF 第幾頁」。
//
// 只做正向同步（source → page）。反向同步（點 PDF → 跳原始碼）需要
// 拿到 PDF 上的點擊座標，而 iframe 裡的瀏覽器內建 viewer 給不了，
// 那要等改用 PDF.js 自繪才做得到。
//
// .synctex.gz 是 gzip 過的純文字，結構大致長這樣：
//
//   Input:1:/abs/path/main.tex        ← tag 1 代表這個檔
//   Input:2:/abs/path/sections/intro.tex
//   {1                                ← 第 1 頁開始
//   [1,23:4736285,42152552:...        ← tag 1 的第 23 行，出現在這一頁
//   }1                                ← 第 1 頁結束
//
// 我們只需要「每頁出現過哪些 (tag,line)」，據此建 line → page 表。
const fs = require("fs");
const zlib = require("zlib");

// 一行記錄的開頭：[ ( h v 都可能帶 tag,line
// 例：[1,23:...  (1,23:...  h1,23:...  v1,23:...
const REC = /^[\[\(hvxkgr$](\d+),(\d+)/;

function parse(gzPath) {
  if (!fs.existsSync(gzPath)) return null;

  let text;
  try {
    text = zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8");
  } catch (e) {
    return null; // 檔案還在寫或壞掉，當作沒有，不要讓預覽整個掛掉
  }

  const files = new Map();   // tag → 絕對路徑
  const pages = new Map();   // "tag:line" → 最小頁碼
  let page = 0;

  for (const line of text.split("\n")) {
    // Input:tag:path — path 本身可能含冒號，所以只切前兩個
    if (line.startsWith("Input:")) {
      const rest = line.slice(6);
      const c = rest.indexOf(":");
      if (c > 0) files.set(rest.slice(0, c), rest.slice(c + 1).trim());
      continue;
    }
    if (line[0] === "{") { page = parseInt(line.slice(1), 10) || page; continue; }
    if (line[0] === "}") { continue; }
    if (!page) continue;

    const m = REC.exec(line);
    if (!m) continue;
    const key = m[1] + ":" + m[2];
    // 同一行可能橫跨數頁（段落被切開），取最小頁，跳過去才是段落開頭
    if (!pages.has(key) || pages.get(key) > page) pages.set(key, page);
  }

  if (!files.size) return null;

  // 反向索引：絕對路徑 → tag（同一個檔可能有多個 tag，全收）
  const tagsOf = new Map();
  for (const [tag, p] of files) {
    const k = fs.existsSync(p) ? fs.realpathSync(p) : p;
    if (!tagsOf.has(k)) tagsOf.set(k, []);
    tagsOf.get(k).push(tag);
  }

  return { files, pages, tagsOf };
}

// 查某個檔的第 line 行落在第幾頁。
// 找不到精確的行就往下找最近的一行——游標常停在空行或註解上，
// 硬要精確匹配會很常回傳 null，體感像壞掉。
function pageOf(idx, file, line) {
  if (!idx) return null;
  const key = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tags = idx.tagsOf.get(key);
  if (!tags) return null;

  let best = null, bestDist = Infinity;
  for (const tag of tags) {
    for (const [k, page] of idx.pages) {
      const c = k.indexOf(":");
      if (k.slice(0, c) !== tag) continue;
      const l = +k.slice(c + 1);
      const dist = Math.abs(l - line);
      // 平手時偏好靠前的頁，避免在頁邊界來回跳
      if (dist < bestDist || (dist === bestDist && page < best)) {
        bestDist = dist;
        best = page;
      }
    }
  }
  return best;
}

module.exports = { parse, pageOf };
