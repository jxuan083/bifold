# NOTES

## 這個工具是幹嘛的

**AI 產出之後的人工微調層。** 不是從零寫東西的編輯器——是拿到一份已經生成好的 deck 或論文，在成品上做中幅到微幅的調整。所以重點一直是「看著成品改」，而不是「寫得快」。

這決定了很多設計：拖邊界改間距、拖屬性名調數值、點成品跳原始碼，全都是為了縮短「看到不對 → 改掉」這段距離。

## 由來（2026-08-26）

原本是某份簡報專案底下的 `editor/`，三個檔，只服務那一份 deck。抽出來獨立成 repo，並加上 LaTeX 支援。

**原專案裡的 `editor/` 沒有動。** 那份還在原地正常運作，這裡是複製出來的分支。哪天要讓原專案改用這個 repo，再處理。

## 為什麼是 Tectonic

- 缺什麼 package 自己抓，不用 `tlmgr install` 一個一個追。BasicTeX 體積小但常缺件，追起來很煩
- 單一 binary，約 50MB。MacTeX 完整版 6GB
- 底層 XeTeX，中文（xeCJK + 系統字型）實測可編，雖然目前主要用途是英文論文

代價是第一次編譯 3 分 25 秒（在抓整套 package）。cache 熱了之後 0.77 秒，這個數字才是決定「即時預覽可不可行」的關鍵——實測過才敢做。

## 反向同步：為什麼放棄零依賴

原本這裡寫著「做不到」。做不到的是**用瀏覽器內建 PDF viewer 做**——iframe 裡的 viewer 拿不到點擊座標。

Leo 的決定是「可以裝啊」，所以改用 PDF.js 自繪 canvas，加了唯一一個 npm 依賴 `pdfjs-dist`（pdf.min.mjs 444KB + worker 1.2MB）。它是 ESM，瀏覽器直接 import，不需要打包工具，所以 server 只是把 `node_modules/pdfjs-dist/build/` 底下的檔案原樣 serve 出去。

這個取捨是對的：反向同步正中這個工具的核心用途（在成品上微調），單向的「跟隨游標」只解決一半。

### SyncTeX 反查的細節

座標單位是 sp，1 pt = 65536 sp。y 從頁面頂端往下遞增，跟 canvas 同向不必翻轉。box 記錄的 y 是 **baseline**，上緣 = y − height、下緣 = y + depth。

**box 是巢狀的**，這是反查最關鍵的一點。整頁的 vbox 也包含你點的位置，直接取「第一個包含這個點的 box」會永遠得到「這一頁」。做法是先把 `h + d > 50pt` 的容器級 box 全部濾掉，只在行級 box 裡找面積最小的。

`k`（kern）與 `g`（glue）記錄沒有高度，收進來反查會挑到沒有視覺範圍的點，所以只收 `[ ( h v` 這四種有 `w,h,d` 的。

有些 `Input:` 的路徑是空的（TeX 內部用），不濾掉會在反查時炸。

## 沒有自動存檔

Overleaf 是自動存的，這裡刻意不是。原本 HTML 模式的契約就是「⌘S 才寫回真實檔案」，加了自動存會讓「改壞了還沒存，關掉就算了」這條退路消失。

`.tex` 模式下 ⌘S 會順帶觸發編譯，一個按鍵完成存檔 + 編譯 + 更新預覽，實際上已經很接近自動的體感。

## 踩過的坑

**iframe 高度歸零**：HTML 模式在 iframe `load` 時會讀 `contentDocument.documentElement.scrollHeight` 來設高度。PDF 模式下那個值是 0，會把 iframe 壓成看不見。修法是 `isTex()` 時直接 return，不共用那段測量邏輯。

**編譯佇列**：編譯期間又按儲存，不能讓兩個 tectonic 並行跑同一個 outdir。用 `compiling` / `queued` 兩個旗標，跑完再補一次。

**SyncTeX 精確匹配會很常失敗**：游標常停在空行、註解、`\begin{...}` 上，這些行不會出現在 SyncTeX 記錄裡。改成往最近的行退之後才堪用。

**同一行跨頁**：段落被切開時同一個 (tag,line) 會出現在兩頁，取最小頁——跳過去才是段落開頭，跳到後半段會很困惑。

**錯誤行號是主檔的行號**：編著 `sections/intro.tex` 時，TeX 報的 `l.123` 是 `main.tex` 的行號，直接跳會跳到錯的地方。所以只有在編主檔時才給「跳到該行」。

**`typeof` 對 TDZ 中的 let 會拋錯**。`typeof x` 只對「未宣告」的識別字安全；對還在暫時性死區的 `let` 一樣拋 ReferenceError。主題切換的 IIFE 在 script 頂端就執行，裡面寫了 `typeof term`，而 `let term` 在檔案後面——結果整個 script 從那裡中斷，後面每一個 `let` 都沒初始化。症狀非常誤導：函式都還在（hoisting），但碰任何變數都說 TDZ。跨區塊要碰後面宣告的變數就掛 `window.__xxx`，不要用 typeof 試探。

**node-pty 的 spawn-helper 沒有執行權限**。npm 解壓 prebuilds 後是 `-rw-r--r--`，spawn 會失敗在 `posix_spawnp failed`，訊息完全看不出是權限問題。`package.json` 加了 postinstall 自動 `chmod +x`，也留了 `npm run fix-pty` 手動修。

**選檔一定要走原生對話框**。瀏覽器的 `<input type="file">` 只給你檔案內容，不給絕對路徑，而這個工具的整個前提就是讀寫硬碟上的真實檔案。走 `osascript` 叫 Finder 反而體驗更好。

## 待辦

- 反向同步（見上）
- 編輯器沒有語法高亮，底層是純 textarea。這是對標 Overleaf 剩下最明顯的差距
- `.bib` 改動不會觸發重編——目前只有存 `.tex` 才編譯
- 檔案樹只能看和切換，不能新增、改名、刪除
- 終端機只有一個分頁，重連等於開一個全新的 shell（狀態不保留）
- 選檔對話框是 `osascript`，只有 macOS 能用
