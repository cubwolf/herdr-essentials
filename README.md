# herdr-essentials

日常用得到的 Herdr App mod(herdr-app 0.1.16 起)。先 private,穩定後轉 public 並加 GitHub topic `herdr-mod`。

| mod | 做什麼 | 狀態 |
|---|---|---|
| `k-tabs` | 內建 `tabs` 的 clone:tab 的 × 改成收起(`tab.settle`),程式繼續跑;tab 列不列已收起的 | Linux 測試環境驗過 |
| `k-spaces` | 內建 `spaces` 的 clone:Space 列右邊的箭頭(旁邊數字=收起幾個)展開所有 tab,點一下叫回;🗑,或再點一次正在顯示的那列(框起來)後按 Del,才真的關(`tab.close`) | Linux 測試環境驗過 |
| `k-tabs` 的 Attach | tab 列右上「📎 Attach」:系統選檔視窗(Linux zenity/kdialog、Windows PowerShell、macOS osascript)→ 路徑加引號貼進目前的 terminal,不按 Enter;遠端機器先 `hc put` 過去。借用剪貼簿後會還原原本的文字 | Linux 測試環境驗過(Claude Code 收到 `[Image #1]`) |

貼上圖片 / 剪貼簿裡的檔案:Herdr 原生已支援(`terminal.paste` / `terminal.paste_image`),先實測再決定要不要補。

## 安裝

```sh
./install.sh                                  # 複製 mods/ 進 App home,並用你的 main.json 做一份 k-main(換成 k-tabs / k-spaces)
herdr-app do layout.switch --name k-main      # 換過去;回原樣:--name main(或 ctrl-alt-shift-escape)
```

內建 mod / layout 每次啟動會被 Herdr 覆蓋,所以一律用 `k-` 前綴的複本。以 herdr-app 0.1.16 的內建版為底。

## 開發

`dev/sandbox/`:Linux 上的隔離測試環境(獨立 core + App home + Xvfb),不碰正在用的 App,見其 README。

追蹤:Tide #286。
