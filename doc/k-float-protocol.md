# k-float 檔案協定

給不經 mod、直接寫檔開桌面視窗的人(agent、腳本)。mod 用 `mods/k-float/float.js`,它做的就是下面這些事。設計緣由見 [ADR 0005](ADR/0005-k-float.md)。

## 一分鐘版

```sh
D=~/.config/herdr-app/data/k-float                      # <App home>/data/k-float
K=~/.config/herdr-app/tools/k-float/target/release/k-float

mkdir -p $D/windows
cat > $D/windows/hello.json <<'EOF'
{ "title": "Hello", "width": 260, "height": 120,
  "html": "<button onclick=\"float.send('hi')\">Say hi</button>" }
EOF
$K start $D                  # 沒在跑才會起;馬上返回

tail -f $D/events/hello.jsonl     # {"type":"ready",…}  按按鈕 → {"type":"message","data":"hi",…}
rm $D/windows/hello.json          # 關視窗
```

## 資料夾

`<App home>/data/k-float/`(App home 預設 `~/.config/herdr-app`;設了 `HERDR_APP_HOME` 就用它)。

| 路徑 | 誰寫 | 用途 |
|---|---|---|
| `windows/<id>.json` | 你 | 一個視窗的 spec。檔案出現 = 開、內容變 = 更新、刪掉 = 關 |
| `events/<id>.jsonl` | 輔助程式 | 這個視窗發生的事,每行一個 JSON |
| `helper.lock` | 輔助程式 | 正在跑的那支的 `pid` 與 `version`;同一個資料夾只會有一支 |
| `helper.log` | 輔助程式 | 輔助程式的錯誤輸出 |
| `stop` | `k-float stop` | 出現就請輔助程式結束 |
| `webview/` | 輔助程式 | 系統 webview 的資料,不用管 |

`<id>`:1 到 64 個字,只能有英數字、`.`、`_`、`-`。其他檔名會被略過。

其實任何資料夾都可以(`k-float start <資料夾>`),一個資料夾一支輔助程式;mod 的 SDK 固定用上面那個。

## 輔助程式

```
k-float start <資料夾>     在背景起一支(已經在跑就什麼都不做),印 started 或 running 後返回
k-float run <資料夾>       留在前景跑(除錯用)
k-float stop <資料夾>      請那支結束(它開的視窗會一起關,spec 檔留著)
k-float --version
```

- 每 0.2 秒看一次 `windows/`。
- 沒有任何視窗滿 30 秒就自己結束。所以每次寫完 spec 都呼叫一次 `start`,最省事。
- 寫 spec 寫到一半被讀到沒關係:解析不了的內容會等下一次再讀。一直解析不了才會記一筆 `error`。
- 檔案開頭帶 BOM 也收(Windows PowerShell 5 的 `Set-Content -Encoding UTF8` 會加)。
- Windows 上,`start` 起的那支不會跟著呼叫它的程式一起被收掉(`hc exec`、mod 的 `exec` 結束時會收掉自己起的所有程序):先試著脫離呼叫者的工作群組,不被允許就請 Windows 代為啟動(WMI)。
- 視窗出現時不搶鍵盤焦點;點它才會拿到。

## spec:`windows/<id>.json`

```json
{
  "html": "<h1>hi</h1>",
  "data": { "count": 3 },
  "title": "k-float",
  "x": 40, "y": 40, "width": 320, "height": 240,
  "topmost": true,
  "clickThrough": false,
  "opacity": 1,
  "frame": true,
  "taskbar": false
}
```

| 欄位 | 預設 | 說明 |
|---|---|---|
| `html` | `""` | 整頁的 HTML(可以有 `<style>`、`<script>`)。改了會重新載入頁面 |
| `data` | `null` | 給頁面的資料,任何 JSON。改了**不會**重新載入頁面,頁面用 `float.onData` 收 |
| `title` | `"k-float"` | 標題列文字 |
| `x`, `y` | 系統決定 | 視窗左上角,邏輯像素(螢幕縮放 200% 時,1 = 2 個實體像素)。兩個都給才算數 |
| `width`, `height` | 320 × 240 | 內容區大小,邏輯像素 |
| `topmost` | `true` | 置頂:蓋過其他程式 |
| `clickThrough` | `false` | 點穿:滑鼠穿過視窗,點到後面的程式。做不到的平台會記一筆 `warning` |
| `opacity` | `1` | 整個視窗的不透明度,0(看不見)到 1(不透明);`0.8` 就看得到一點後面的程式。字、圖、標題列一起變淡。隨時可以改,不會重新載入頁面。桌面不會疊合視窗時(X11 沒開合成器)記一筆 `warning`,視窗照常顯示成不透明 |
| `frame` | `true` | 系統的標題列與邊框。`false` 就只剩內容(自己在頁面裡畫關閉鈕) |
| `taskbar` | `false` | 要不要出現在工作列 |

沒列出的欄位會被忽略,所以可以放自己的東西。

更新:把整個檔案寫成新的內容(不是只寫要改的欄位)。先讀回來再改,因為 `x` / `y` / `width` / `height` 可能被輔助程式更新過(見下)。

## 頁面裡:`window.float`

輔助程式在每一頁的腳本之前注入:

```js
float.send(value)      // 傳一筆給外面:事件檔多一行 {"type":"message","data":value}
float.onData(fn)       // spec 的 data 每次改變時呼叫 fn(data);註冊時若已有資料會先叫一次
float.data             // 目前的 data
```

只讓背景透明、字不變淡(頁面自己用透明底色)沒有做:WebKitGTK 2.52 在透明視窗上重畫時不會先清掉上一張,幾秒內就疊成不透明、舊字也留著(2026-11-25 在 Mint 實測)。

頁面是本機字串載入的,第一版不支援載外部網址當整頁(頁面裡自己 `fetch`、放 `<img src="https://…">` 不受限)。

## 事件:`events/<id>.jsonl`

每行一個 JSON,都有 `seq`(這個視窗的流水號,從 1 起,輔助程式重開也接著數)與 `t`(Unix 毫秒)。

| `type` | 其他欄位 | 什麼時候 |
|---|---|---|
| `ready` | | 頁面載入完成(改 `html` 重新載入後也會再來一次) |
| `message` | `data` | 頁面呼叫了 `float.send(data)` |
| `moved` | `x`, `y` | 使用者拖動視窗,放開之後 |
| `resized` | `width`, `height` | 使用者改視窗大小,放開之後 |
| `closed` | `by`: `"user"` 或 `"spec"` | 視窗關了。`user` = 使用者按了關閉;`spec` = spec 檔被刪掉 |
| `warning` | `message` | 做不到但不影響其他功能(例:這個平台不支援點穿) |
| `error` | `message` | spec 解析不了、視窗開不起來、頁面載不進去 |

讀的人自己記「處理到哪個 `seq`」,下次只處理比它大的。

- 檔案超過 256 KiB 時,輔助程式會只留最後 200 行(`seq` 不變)。
- 如果看到最後一行的 `seq` 比自己記的還小,代表檔案被人重建了,從頭讀。

輔助程式會跟著改 spec 檔的兩種情況:

- 使用者**移動 / 改大小**:把新的 `x` / `y` / `width` / `height` 寫回 spec 檔(其他欄位照舊)。
- 使用者**關掉視窗**:刪掉 spec 檔。所以「spec 檔還在不在」就是「視窗還開著嗎」。

## 平台

| | Linux Mint(X11) | Windows |
|---|---|---|
| webview | WebKitGTK(`libwebkit2gtk-4.1`) | WebView2(Windows 11 內建) |
| 置頂 | ✅(`_NET_WM_STATE_ABOVE`) | ✅ |
| 點穿 | ✅ | ✅ |
| 半透明(`opacity`) | ✅ 要有合成器(Mint MATE 的 Marco 驗過) | 寫了,還沒在 Windows 上跑過 |
| Wayland | 不保證置頂 | — |

## 建置

```sh
cd tools/k-float && cargo build --release     # 產出 target/release/k-float(.exe);install.sh 會幫你跑
tools/k-float/tests/smoke.sh                  # Linux:在測試環境的 Xvfb :99 跑一輪
powershell -NoProfile -ExecutionPolicy Bypass -File tools\k-float\tests\smoke.ps1   # Windows:在互動桌面跑(不要經 ssh),會開一個小視窗約 15 秒
K_FLOAT_DISPLAY=:0 tools/k-float/tests/desktop.sh   # Linux:在實體桌面驗置頂 / 移動 / 使用者關窗(會開一個小視窗約 10 秒)
```

Linux 建置需要 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`。
