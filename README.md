# bifold

左邊原始碼，右邊成品。改完 ⌘S 直接寫回硬碟上的真實檔案——不做副本，所以不會有兩份來源分岔。

支援兩種來源：

| 來源 | 右邊看到的 | 能做什麼 |
|---|---|---|
| `.html` | 頁面本身 | 點元素跳到對應行、拖邊界改間距、拖屬性名調數值、匯出 PPTX |
| `.tex` | Tectonic 編出的 PDF | 游標移到哪行，PDF 就跳到那頁；編譯錯誤直接標行號 |

零外部依賴，只用 Node 內建模組。`.tex` 需要另外裝 Tectonic。

## 用法

```bash
node src/server.js 8790 /abs/path/to/deck.html
node src/server.js 8790 /abs/path/to/paper/main.tex
```

啟動後開 http://127.0.0.1:8790，也可以在網頁左上貼另一個檔案的絕對路徑切換。

`.tex` 需要先裝引擎：

```bash
brew install tectonic
```

## HTML 模式

預覽是即時注入行號的副本，**原始檔完全不動**。每個開標籤會被掛上 `data-l`（原始行號）與 `data-i`（序號），`<style>` 區塊跳過不注入，否則 CSS 會被寫壞。

- **選取模式** — 點預覽上的元素，左邊跳到對應行並選取整行
- **拖邊界** — 滑鼠移到 margin / padding 邊界會變成調整游標，拖了就改，放開才寫回原始碼的 inline style。會吸附到同層兄弟的相同屬性，其次吸附到 4 的倍數，按住 Alt 停用吸附
- **屬性面板** — 拖屬性名稱左右滑動改數值，即時反映在預覽上
- **⌘S** 寫回真實檔案，**匯出 PPTX** 呼叫專案既有的 `build-pptx.sh`，維持單一建置路徑

序號的數法在前後端必須完全一致，否則寫回會寫到錯的標籤上——這是 `server.js` 的 `injectMarkers` 和 `ui.html` 的 `tagStart` 共用同一組規則的原因。

## LaTeX 模式

論文通常不是單一檔案。開啟 `sections/intro.tex` 時，bifold 會往上最多三層找出真正的主檔（含 `\documentclass` 的那個，或 `main.tex` / `paper.tex` / `thesis.tex` / `index.tex`），**編譯主檔而不是當前檔**，否則預覽會是一份沒有 preamble 的殘骸。標題列會顯示 `intro.tex → main.tex` 讓你知道實際編的是哪份。

編譯產物全部進 `.bifold/`，方便一行 gitignore。

**跟隨游標**：游標停在第幾行，右邊 PDF 就跳到那一頁，靠解析 SyncTeX 做的。找不到精確的行會往最近的行退——游標常停在空行或註解上，硬要精確匹配會很常失敗，體感像壞掉。

**編譯錯誤**：TeX log 動輒上千行，全部丟出來等於沒給，所以只抓第一個 `!` 錯誤和它的 `l.123` 行號，完整 log 收在「完整 log」後面。

### 編譯速度

| 情境 | 實測 |
|---|---|
| 第一次跑（Tectonic 抓整套 package） | 3 分 25 秒 |
| 遇到沒抓過的 package 組合 | 約 31 秒 |
| cache 全熱 | **0.77 秒** |

第一次會久，之後就不會了。選 Tectonic 而不是 MacTeX 是因為它會自己抓缺的 package，不必手動 `tlmgr install` 追缺件；代價就是第一次那三分鐘。

## 已知限制

**點 PDF 跳回原始碼做不到。** PDF 是交給瀏覽器內建的 viewer 顯示的，拿不到點擊座標，所以只有「原始碼 → PDF」單向。要做雙向必須改用 PDF.js 自繪，那會引入約 1.5MB 依賴。詳見 `NOTES.md`。

`.tex` 模式下選取模式、屬性面板、PPTX 匯出都會隱藏——PDF 是編譯產物，沒有能對應回原始碼的 DOM。
