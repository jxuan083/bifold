// SyncTeX 解析：原始碼行 ↔ PDF 位置，雙向。
//
//   pageOf(idx, file, line)     → 第幾頁      （正向，游標跟隨用）
//   reverse(idx, page, x, y)    → {file,line} （反向，點 PDF 跳原始碼用）
//
// 座標單位是 sp（scaled point），1 pt = 65536 sp。y 從頁面頂端往下遞增，
// 跟 PDF.js 的 canvas 座標同向，不需要翻轉。
// box 記錄的 y 是 baseline，所以上緣 = y - height、下緣 = y + depth。
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

// 有完整幾何資訊的 box：type tag,line:x,y:width,height,depth
// kern（k）與 glue（g）沒有高度，拿來反查會挑到沒有視覺範圍的點，所以不收。
const BOX = /^([\[\(hv])(\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/;
const SP = 65536;

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
  const boxes = new Map();   // page → [{tag,line,x,y,w,h,d}]（單位 pt）
  let page = 0;

  for (const line of text.split("\n")) {
    // Input:tag:path — path 本身可能含冒號，所以只切前兩個。
    // 有些 tag 的路徑是空的（TeX 內部用），收進來反查時會炸，濾掉。
    if (line.startsWith("Input:")) {
      const rest = line.slice(6);
      const c = rest.indexOf(":");
      const fp = c > 0 ? rest.slice(c + 1).trim() : "";
      if (fp) files.set(rest.slice(0, c), fp);
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

    const b = BOX.exec(line);
    if (!b) continue;
    if (!boxes.has(page)) boxes.set(page, []);
    boxes.get(page).push({
      tag: b[2], line: +b[3],
      x: +b[4] / SP, y: +b[5] / SP,
      w: +b[6] / SP, h: +b[7] / SP, d: +b[8] / SP,
    });
  }

  if (!files.size) return null;

  // 反向索引：絕對路徑 → tag（同一個檔可能有多個 tag，全收）
  const tagsOf = new Map();
  for (const [tag, p] of files) {
    const k = fs.existsSync(p) ? fs.realpathSync(p) : p;
    if (!tagsOf.has(k)) tagsOf.set(k, []);
    tagsOf.get(k).push(tag);
  }

  return { files, pages, boxes, tagsOf };
}

// 反向：PDF 上點了 (x, y)（單位 pt，原點左上），是原始碼的哪一行。
//
// 挑選規則是「包含這個點、而且面積最小的 box」。SyncTeX 的 box 是巢狀的——
// 整頁的 vbox 也包含這個點，但它對應的行號沒有意義；越內層的 box 越接近
// 使用者真正點到的那個字。
// 一行文字的高度。超過這個就是段落或整頁的容器 box——它們包含頁面上幾乎所有點，
// 對定位沒有價值，拿來回答「你點到哪一行」只會得到「這一頁」。
const LINE_MAX = 50;

function pick(list, x, y) {
  let hit = null, hitArea = Infinity;
  let near = null, nearDist = Infinity;

  for (const b of list) {
    const top = b.y - b.h, bot = b.y + b.d;
    if (x >= b.x && x <= b.x + b.w && y >= top && y <= bot) {
      const area = Math.max(b.w, 0.01) * Math.max(b.h + b.d, 0.01);
      if (area < hitArea) { hitArea = area; hit = b; }
    }
    // near 一律算。點落在行距裡是常態，那時「最近的那一行」才是答案，
    // 而不是某個剛好罩住這個點的大盒子。
    const dy = y < top ? top - y : y > bot ? y - bot : 0;
    const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
    const dist = dy * 4 + dx;   // 垂直為主：同一行左右移動不該換到別行去
    if (dist < nearDist) { nearDist = dist; near = b; }
  }
  return { hit, near, nearDist };
}

function reverse(idx, page, x, y) {
  if (!idx) return null;
  const list = idx.boxes.get(page);
  if (!list || !list.length) return null;

  // 先只看行級的 box。找不到才退回全部——空白頁或圖片頁可能真的只有大 box。
  const lines = list.filter((b) => b.h + b.d <= LINE_MAX);
  let r = lines.length ? pick(lines, x, y) : null;
  if (!r || (!r.hit && r.nearDist > 72)) r = pick(list, x, y);   // 差一英寸以上就別硬湊

  const b = r.hit || r.near;
  if (!b) return null;
  // 只剩容器級的 box 可選，代表這個點附近根本沒有文字（頁尾空白、圖片頁）。
  // 這時候不動比跳到一個無關的行好。
  if (b.h + b.d > LINE_MAX) return null;
  const file = idx.files.get(b.tag);
  if (!file) return null;
  return {
    file, line: b.line, exact: !!r.hit,
    // 幾何一併回傳，前端才能把「系統認為你點到這裡」畫出來。
    // 反查不可能永遠精準，讓它可見比假裝準確好。
    box: { x: b.x, y: b.y, w: b.w, h: b.h, d: b.d },
  };
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

module.exports = { parse, pageOf, reverse };
