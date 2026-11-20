# herdr-essentials

日常用得到的 Herdr App mod(herdr-app 0.1.16 起)。先 private,穩定後轉 public 並加 GitHub topic `herdr-mod`。

| mod | 做什麼 | 狀態 |
|---|---|---|
| `k-tabs` | 內建 `tabs` 的 clone:tab 的 × 改成收起(`tab.settle`),程式繼續跑;tab 列不列已收起的 | Linux 測試環境驗過 |
| `k-spaces` | 內建 `spaces` 的 clone:Space 列右邊的箭頭(旁邊數字=收起幾個)展開所有 tab,點一下叫回;🗑,或再點一次正在顯示的那列(框起來)後按 Del,才真的關(`tab.close`) | Linux 測試環境驗過 |
| `k-tabs` 的 Attach | tab 列右上「📎 Attach」:系統選檔視窗(Linux zenity/kdialog、Windows PowerShell、macOS osascript)→ 路徑加引號貼進目前的 terminal,不按 Enter;遠端機器先 `hc put` 過去。借用剪貼簿後會還原原本的文字 | Linux 測試環境驗過(Claude Code 收到 `[Image #1]`) |
| `k-tabs` 的 Paste shot | 剪貼簿裡有圖片時,tab 列多一顆「🖼 Paste shot」:把圖存成暫存 PNG,再像 Attach 一樣把路徑貼進 terminal(Claude Code 會變成圖片),之後把圖放回剪貼簿。補 Herdr 在 Windows 上 Ctrl+V 只貼文字的缺口。偵測靠 Windows PowerShell / Linux `xclip`(Wayland `wl-paste`)/ macOS `osascript`,沒有這些工具就不會出現。按下後約 2–4 秒剪貼簿暫時是路徑文字,圖放回去時會蓋掉這段時間複製的東西 | Linux 測試環境 + Windows laptop 驗過 |
| `k-agents` | 內建 `agents` 的 clone:側欄 Agents 列(含子 agent)右鍵 →「Copy address」,把 terminal 位址(`t8`,別台機器是 `laptop/t8`)複製到剪貼簿,給 `hc send` 等指令用 | Linux 測試環境驗過 |
| `k-chrome` + `k-profiles` | 多開視窗:左下角多一列「Profiles」,打開是 profile 管理頁。每個 profile 是一個獨立的 App home(`~/.config/herdr-app-<名字>`,和預設 home 放在同一層),有自己的版面、設定和顯示中的 Space;terminal 是同一批,因為共用同一個 core。新增時複製目前視窗的版面、mod 和設定,並建一個固定入口:Windows 開始選單「Herdr (名字)」(`.lnk` → 同資料夾的 `open-herdr.vbs`,開啟時不會閃黑窗),Linux 應用程式選單(`.desktop`);macOS 只能從管理頁開。移除只刪清單和入口,資料夾保留。加入的名字對應的資料夾已存在(被移除過的、或自己手動建的)就收編:缺的才補(版面、mod、主題逐個補),已有的檔不覆蓋;手動建的資料夾若原本是 `main` 版面,收編後要自己 `layout.switch --name k-main` 一次。清單存在 `herdr-profiles.json`(和預設 home 同一層) | Linux 測試環境驗過 |
| `k-mods` | Mod 管理頁,長得像 VS Code 的擴充功能頁:左下「Mods」列打開(`herdr-app do mod.open --name k-mods` 也行)。左邊搜尋框 + Installed / Marketplace 兩個分頁,右邊是選到的 mod 的詳細資料和按鈕。Installed:自己的 mod 在上(來源 `owner/repo @sha7`、`local` 或 `link`,有新版會標 update available),Herdr 內建的收在「Built-in」群組、不能刪也不能停用。Marketplace:GitHub topic `herdr-mod` 的 repo(有 `gh` 就用登入身分查,沒有就匿名),搜尋、Load more 分頁。安裝 / 更新前先在右邊顯示審查:會複製什麼、程式碼會不會執行程式 / 連網 / 讀寫檔案、加哪些快捷鍵,同名就擋下;按 Confirm 才裝。Disable 把 mod 搬到 `mods-disabled/`,Enable 搬回來;被 layout 用到的(例如 k-main 的 k-tabs)會拒絕並說是哪個 layout。Windows 走 PowerShell(未在 Windows 實測)。改自 [jacksonpires/herdr-app-mod-manager](https://github.com/jacksonpires/herdr-app-mod-manager)(MIT,見 `THIRD-PARTY-NOTICES.md`) | Linux 測試環境驗過 |

搜過沒有現成可用的:`Hypercubed/herdr-app-focus-window` 能從 Space 選單開新視窗,但每次都是新的 home,而且沒有授權條款;`GiorgiTarsaidze/herdr-profiles` 是給終端機版 herdr 的。

貼上圖片:Linux / macOS 的 Ctrl+V 原生就行;Windows 上 Herdr 的 Ctrl+V 只貼文字,用 Paste shot 按鈕(或 Claude Code 自己的 Alt+V)。

## 安裝

```sh
git clone https://github.com/kirinchen/herdr-essentials.git
cd herdr-essentials
./install.sh                                  # App home 的 mods/k-* 以 symlink 指到這個 repo,並用你的 main.json 做一份 k-main(換成 k-tabs / k-spaces / k-chrome / k-agents)
herdr-app do layout.switch --name k-main      # 換過去;回原樣:--name main(或 ctrl-alt-shift-escape)
```

- **symlink 模式(預設)**:改 repo 裡的 `mods/` 即熱重載,直接 `git commit` / `push`;其他機器 `git pull` 就同步,不必重跑。
- **複製模式**:`./install.sh --copy`。Windows 沒開 symlink 權限時用;之後有改動要重跑才會更新。
- `k-main.json` 是從本機的 `main.json` 產生的,放在 App home,不在 repo;已存在就不重做,只補新版的換法(目前是 `workspace-chrome` → `k-chrome`、`agents` → `k-agents`,底部加高到 125px 放 Settings / Add machine / Profiles / Mods 四列;舊版的 97px 會補加高);要整份重做先刪掉。
- App 會在每個 mod 目錄自動寫入 `gpui-kit.d.ts`、`jsconfig.json`,已在 `.gitignore`。

herdr-app 本身沒有同步 mod 的功能,每台機器都要 clone + `./install.sh` 一次。
內建 mod / layout 每次啟動會被 Herdr 覆蓋,所以一律用 `k-` 前綴的複本。以 herdr-app 0.1.16 的內建版為底。

## 開發

`dev/sandbox/`:Linux 上的隔離測試環境(獨立 core + App home + Xvfb),不碰正在用的 App,見其 README。

`tests/`:`node --test tests/`(或 `npm test`,Node 18+)跑 k-mods 的 `core.js`(真的 git clone 本機暫存 repo,不連網)。

追蹤:Tide #286。
