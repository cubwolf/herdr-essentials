# ADR 0002:浮動筆記(k-note)

- 狀態:Proposed
- 日期:2026-11-23
- 相關:`openOverlay`(`herdr.d.ts` 的 `OverlaySpec`)、`exec`、`writeTextFile` / `watchFolder`

## 背景

想要一張一直浮在最上層的筆記,而且 mod 和 agent 都能把內容寫進去,例如目前的卡片、待辦、提醒。

「最上層」有兩種意思,做法差很多:

| 範圍 | 意思 | Herdr 本身做得到嗎 |
|---|---|---|
| 只在 Herdr 視窗內 | 蓋過 Herdr 裡的 terminal、側欄、對話框 | 可以:`openOverlay({ kind: "window" })` |
| 整個桌面 | 蓋過瀏覽器、VS Code 等其他程式;Herdr 最小化也看得到 | 不行:overlay 是畫在 Herdr 視窗裡面的,不是系統視窗 |

`kind: "window"` 的特性(來自 `herdr.d.ts`):
- 會一直開著,不會讓背景變暗,點旁邊也不會關;
- 可以拖曳,放在哪裡就停在哪裡;
- 有 `key` 時,會記住上次的位置;
- 加上 `keep: true` 時,下次啟動會自動重開;
- 切換版面時會關閉(有 `keep` 的,切回原本的版面會再出現)。

## 決定

分兩階段做,兩階段共用**同一份筆記檔**:

### 階段 A:Herdr 內的浮動筆記(mod `k-note`)

- 開啟方式:`openOverlay({ mod: "k-note", kind: "window", key: "k-note", keep: true, width: 280, height: 220 })`。
- 入口:快捷鍵(在 Settings → Keys 綁 `mod.open:k-note` 或自訂指令)。標題列再加一個按鈕。
- 內容存在 App home 的 `data/k-note/note.md`,純文字 / Markdown 都可以。
  - mod 用 `watchFolder` 監看這個檔案,檔案一變就重畫。
  - 因此其他 mod、agent(直接寫檔)、腳本都能更新筆記內容。
- 筆記本身可以直接編輯(`Input`),存檔用 `writeTextFile` 並帶上 `expected`,避免蓋掉別人剛寫的內容。

### 階段 B:桌面最上層(Windows 小程式 `k-note-win`,需要時才做)

- 做法:一支無邊框、`TopMost` 的小視窗。用 C# WPF 寫,一支 exe 就好,不需要另外裝執行環境。
- 讀**同一份** `note.md`,用 `FileSystemWatcher` 監看,有變就重畫;小程式重開也不會掉內容。
- mod 啟動它:`exec("cmd", ["/c", "start", "", "k-note-win.exe", notePath])`。
  - 要讓小程式脫離 Herdr 自己跑。原因是 `exec` 最多等 10 分鐘,時間一到會被收掉。
- 跨機:back 的 mod 用 `exec(..., { on: "laptop" })` 就能叫出 laptop 的筆記,前提是 laptop 的 core 連得到。

## 不選的做法

- **用 localhost HTTP 溝通**:mod 的 API 沒有 `fetch`,得經過 `exec` 跑 `curl`,比較繞,而且還要處理埠號和程式有沒有在跑。走檔案最單純。
- **一開始就做 Electron / Tauri**:只為一張筆記太重,而且還要另外安裝。
- **把筆記放進側欄的固定區塊**:不會浮在最上層,對話框打開時就被蓋住,不符合需求。

## 待決

1. 筆記內容主要是誰寫?手打,還是 agent / mod 自動寫(例如目前的 Tide 卡、k-pick 指到的東西)?這會決定要不要分多張筆記。
2. 每個 profile 各一份筆記,還是全部共用一份?
3. 階段 B 的小程式要不要可以點穿(透明、不擋滑鼠),還是要能直接編輯?
4. 階段 A 切換版面時筆記會關閉:要不要讓 `k-note` 在每個 k- 版面都加 `keep`?
