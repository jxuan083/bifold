// HTML 簡報 → PPTX，截圖式。
//
// 為什麼是截圖而不是轉成原生形狀：HTML 和 OOXML 的排版模型不同，中文斷行
// 尤其無法等價轉換。向量轉換路線做得出來，但 PowerPoint 重排 CJK 會把標題
// 硬拆行、疊字，修復成本高於重做。Marp 基於同樣理由也選截圖。
//
// 需要可編輯的版本時，正確答案是交付 .html 本身。
//
// 三步：Chrome headless 印成 PDF → pdftoppm 每頁出圖 → pptxgenjs 鋪滿版面。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DPI = 200;

const run = (cmd, args, opts) => new Promise((ok, bad) => {
  execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.detail = (stdout || "") + (stderr || ""); return bad(err); }
    ok((stdout || "") + (stderr || ""));
  });
});

function check() {
  if (!fs.existsSync(CHROME)) throw new Error("找不到 Google Chrome，PDF 這步需要它");
}

// html 檔的絕對路徑 → 同目錄的同名 .pptx
async function build(htmlFile, log = () => {}) {
  check();
  const outPptx = htmlFile.replace(/\.html?$/i, "") + ".pptx";
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bifold-pptx-"));
  const pdf = path.join(work, "deck.pdf");

  try {
    log("[1/3] 由 HTML 產生 PDF");
    // 用 file:// 讀硬碟上的檔案，所以要先存檔。相對路徑的圖片字型才拿得到。
    await run(CHROME, [
      "--headless", "--disable-gpu", "--no-sandbox",
      "--print-to-pdf-no-header", "--print-to-pdf=" + pdf,
      "file://" + encodeURI(htmlFile).replace(/#/g, "%23"),
    ]);
    if (!fs.existsSync(pdf)) throw new Error("Chrome 沒有產生 PDF");

    log("[2/3] 每頁輸出 " + DPI + " DPI 截圖");
    await run("pdftoppm", ["-jpeg", "-r", String(DPI), "-jpegopt", "quality=92",
                           pdf, path.join(work, "s")]);
    const shots = fs.readdirSync(work).filter((f) => /^s.*\.jpg$/i.test(f)).sort();
    if (!shots.length) throw new Error("pdftoppm 沒有輸出任何頁面");

    log("[3/3] 組裝 PPTX（" + shots.length + " 頁）");
    const pptxgen = require("pptxgenjs");
    const pres = new pptxgen();
    pres.layout = "LAYOUT_WIDE";          // 13.333 x 7.5 吋，對應 1600 x 900 px
    pres.title = path.basename(htmlFile).replace(/\.html?$/i, "");
    for (const f of shots) {
      pres.addSlide().addImage({ path: path.join(work, f), x: 0, y: 0, w: 13.333, h: 7.5 });
    }
    await pres.writeFile({ fileName: outPptx });

    return { pptx: outPptx, pages: shots.length };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { build };
