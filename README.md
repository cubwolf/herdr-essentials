# herdr-essentials

日常用得到的 Herdr App mod(herdr-app 0.1.16 起)。先 private,穩定後轉 public 並加 GitHub topic `herdr-mod`。

| mod | 做什麼 | 狀態 |
|---|---|---|
| `k-tabs` | 內建 `tabs` 的 clone:tab 的 × 改成收起(`tab.settle`),程式繼續跑;tab 列不列已收起的 | Linux 測試環境驗過 |
| `k-spaces` | 內建 `spaces` 的 clone:Space 列右邊的箭頭(旁邊數字=收起幾個)展開所有 tab,點一下叫回;🗑,或再點一次正在顯示的那列(框起來)後按 Del,才真的關(`tab.close`) | Linux 測試環境驗過 |
| `k-tabs` 的 Attach | tab 列右上「📎 Attach」:系統選檔視窗(Linux zenity/kdialog、Windows PowerShell、macOS osascript)→ 路徑加引號貼進目前的 terminal,不按 Enter;遠端機器先 `hc put` 過去。借用剪貼簿後會還原原本的文字 | Linux 測試環境驗過(Claude Code 收到 `[Image #1]`) |
| `k-tabs` 的 Paste shot | 剪貼簿裡有圖片時,tab 列多一顆「🖼 Paste shot」:把圖存成暫存 PNG,再像 Attach 一樣把路徑貼進 terminal(Claude Code 會變成圖片),之後把圖放回剪貼簿。補 Herdr 在 Windows 上 Ctrl+V 只貼文字的缺口。偵測靠 Windows PowerShell / Linux `xclip`(Wayland `wl-paste`)/ macOS `osascript`,沒有這些工具就不會出現 | Linux 測試環境驗過 |

貼上圖片:Linux / macOS 的 Ctrl+V 原生就行;Windows 上 Herdr 的 Ctrl+V 只貼文字,用 Paste shot 按鈕(或 Claude Code 自己的 Alt+V)。

## 安裝

```sh
git clone https://github.com/kirinchen/herdr-essentials.git
cd herdr-essentials
./install.sh                                  # App home 的 mods/k-* 以 symlink 指到這個 repo,並用你的 main.json 做一份 k-main(換成 k-tabs / k-spaces)
herdr-app do layout.switch --name k-main      # 換過去;回原樣:--name main(或 ctrl-alt-shift-escape)
```

- **symlink 模式(預設)**:改 repo 裡的 `mods/` 即熱重載,直接 `git commit` / `push`;其他機器 `git pull` 就同步,不必重跑。
- **複製模式**:`./install.sh --copy`。Windows 沒開 symlink 權限時用;之後有改動要重跑才會更新。
- `k-main.json` 是從本機的 `main.json` 產生的,放在 App home,不在 repo;已存在就不覆蓋,要重做先刪掉。
- App 會在每個 mod 目錄自動寫入 `gpui-kit.d.ts`、`jsconfig.json`,已在 `.gitignore`。

herdr-app 本身沒有同步 mod 的功能,每台機器都要 clone + `./install.sh` 一次。
內建 mod / layout 每次啟動會被 Herdr 覆蓋,所以一律用 `k-` 前綴的複本。以 herdr-app 0.1.16 的內建版為底。

## 開發

`dev/sandbox/`:Linux 上的隔離測試環境(獨立 core + App home + Xvfb),不碰正在用的 App,見其 README。

追蹤:Tide #286。
