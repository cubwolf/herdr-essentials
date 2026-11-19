# herdr-essentials

日常用得到的 Herdr App mod(herdr-app 0.1.16 起)。先 private,穩定後轉 public 並加 GitHub topic `herdr-mod`。

| mod | 做什麼 | 狀態 |
|---|---|---|
| `k-tabs` | 內建 `tabs` 的 clone:tab 的 × 改成收起(`tab.settle`),程式繼續跑 | 規劃中 |
| `k-spaces` | 內建 `spaces` 的 clone:Space 底下展開列出所有 tab(含收起的),點一下叫回、🗑 才真的關 | 規劃中 |
| `k-attach` | 「＋ 附加檔案」按鈕:選檔後把路徑貼進 terminal(不按 Enter) | 規劃中 |

貼上圖片 / 剪貼簿裡的檔案:Herdr 原生已支援(`terminal.paste` / `terminal.paste_image`),先實測再決定要不要補。

## 安裝

把 `mods/<name>/` 複製到 `~/.config/herdr-app/mods/`(或 `$HERDR_APP_HOME/mods/`),再跑 `herdr-app check ~/.config/herdr-app/mods/<name>`。
clone 出來的 mod 要配一份自己的 layout(`layout.clone main`)把對應的 block 指過去。

追蹤:Tide #286。
