# ADR 0003:視窗之間互相呼叫(Show in 另一個視窗)

- 狀態:Proposed
- 日期:2026-11-23
- 相關:`mods/k-settings/profiles.js`(profile 清單 `herdr-profiles.json`)、`mods/k-spaces/menu.js`、ADR 0001(每個視窗的隱藏清單)、ADR 0002(浮動筆記,同樣用檔案傳內容)

## 背景

想要像 VS Code 那樣,把某個 tab 拉到另一個螢幕的視窗。Herdr 做不到這件事:
- 一個 tab 或 pane 沒辦法拖出去變成自己的視窗;
- mod 的 `kind: "window"` 只畫在主視窗裡面。

能做到的是開第二個 profile 視窗,放在另一個螢幕。所有 profile 視窗接的是同一個 herdr-core,看得到同一批 space、tab、terminal。

剩下的問題是,怎麼從 A 視窗叫 B 視窗去顯示某個東西。

## 已確認

- 每個 profile 視窗有自己的 App home 和 socket。`herdr-app` 指令照 `HERDR_APP_HOME` 決定要送到哪個視窗。
- 2026-11-23 實測:
  - 指令:`HERDR_APP_HOME=<測試環境的 App home> herdr-app do mod.open --name k-settings`。
  - 結果:測試環境那個視窗打開了 Settings(回 `{"ok": true}`,截圖確認)。
  - 意思是,一個視窗可以叫另一個執行中的視窗跑任何 `herdr-app do` 指令。
- `shared.json` 是每個視窗各自一份,所以 A 的 `setShared` 傳不到 B。
- 指令清單裡沒有「把視窗帶到最前面」(focus / raise)的指令。

## 決定

### 1. 呼叫方式

mod 透過 `exec` 執行 `herdr-app do …`,同時設定 `HERDR_APP_HOME`。`exec` 本身沒有環境變數參數,所以要用 shell 包一層:

| 平台 | 寫法 |
|---|---|
| Linux / macOS | `exec("sh", ["-c", 'HERDR_APP_HOME="$1" herdr-app do "$2" "$3"', "sh", home, cmd, json])` |
| Windows | `exec("cmd", ["/c", "set", "HERDR_APP_HOME=…", "&&", "herdr-app", "do", …])`,或改用 `pwsh -c` 加上 `$env:HERDR_APP_HOME`(實作時再測哪種在引號處理上比較穩) |

- 路徑和參數用位置參數傳進去,不要直接拼進字串,避免路徑有空白或引號時壞掉。
- 共用的部分做成小函式 `callWindow(home, command, args)`,放在 `mods/k-settings/windows.js`,k-spaces 從那裡 import。

### 2. 找到其他視窗

- 視窗清單:預設的 App home,加上 `herdr-profiles.json` 列出的每個 profile 的 `home`(Profiles 頁本來就在讀這份)。
- 判斷某個視窗有沒有開:`herdr-app status`(有設 `HERDR_APP_HOME`)成功就是開著的。
  - 只在右鍵選單打開時查一次。
  - timeout 設短(約 2 秒),避免卡住選單。
- 不列出自己(App home 等於 `appHome()` 的那個)。

### 3. 第一個功能:Show in 〈視窗〉

- Space 右鍵:「Show in › 〈視窗名稱〉」,在那個視窗執行 `space.select`。
- tab 右鍵:同一個選單,在那個視窗執行 `tab.select` 或 `terminal.show`。
- 選了沒開的視窗:先用 Profiles 頁的 `open(home)` 把它開起來,等 `status` 成功再送指令。
- 如果那個 space 在 B 被藏起來了(ADR 0001):先在 B 取消隱藏。
  - 隱藏清單存在 B 的 `shared.json`,A 不能直接改。
  - 做法:A 寫一個請求檔到 B 的 App home,B 的 k-spaces 監看這個檔,讀到後自己 Unhide。這跟下面第 4 點是同一個機制。

### 4. 傳自訂內容(需要時才做)

- 指令不夠用時(例如要把筆記內容、要取消隱藏的 space 傳過去),走檔案:
  - A 用 `writeTextFile` 寫到 `<B home>/data/k-inbox/<時間>-<種類>.json`;
  - B 的 mod 用 `watchFolder` 監看,讀完就刪掉。
- 跟 ADR 0002 的筆記檔是同一種做法。

## 不選的做法

- **把 tab 真的拖到另一個視窗**:Herdr 沒有這個 API,mod 做不到。
- **透過 herdr-core 傳訊息**:core 管的是 terminal 和排版,不管各視窗要顯示什麼,也沒有給 mod 用的訊息管道。
- **讓所有視窗共用同一個 `shared.json`**(symlink):會連帶把隱藏清單、展開狀態等每個視窗各自的設定一起共用,跟 ADR 0001 的決定衝突。

## 限制

- B 不會跳到最前面:Herdr 沒有 focus / raise 指令,B 被蓋住時要自己點一下。之後可以考慮在 B 跳 toast(`notify`)提醒。
- 只限同一台電腦上的視窗。另一台機器(例如 laptop)的視窗要經過 `exec(..., { on })`,而且路徑、平台都不一樣,先不做。

## 待決

1. 「Show in」是放在右鍵選單第一層(視窗少的時候比較快),還是做成子選單?
2. 選了沒開的視窗,要自動開起來,還是只列出已經開著的視窗?
3. 要不要另外提供快捷鍵版本,例如「把目前的 tab 送到下一個視窗」?
