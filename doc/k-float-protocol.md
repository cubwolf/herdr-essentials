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
| `paused` | `install.sh` | 重建輔助程式期間放著:`start` 不起新的(印 `paused`),免得 Windows 換不掉執行中的檔。超過 15 分鐘的當成沒有 |
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
- 看不到的位置不照用:寬或高小於 20,改成預設 320 × 240;視窗不在任何一個螢幕上(例如 Windows 縮小時的停放位置 -32000,125% 縮放下是 -25600;拔掉的螢幕),移到主螢幕正中間。改了就寫回 spec,並記一筆 `moved` / `resized`。
- 輔助程式被收掉時(`install.sh` 重建、當掉),視窗跟著不見,spec 檔留著。`install.sh` 建完會再 `start` 一次;mod 用 SDK 的 `float.listen` 時,SDK 每分鐘看一次:spec 還在就 `start`。

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
| `behindOpacity` | 沒有 | 使用者在用**被這個視窗蓋住的**視窗時(這個視窗沒有焦點,而作用中的視窗跟它重疊)改用這個不透明度;回到這個視窗(取得焦點)或作用中的視窗移開,就回到 `opacity`。桌面、工作列不算。沒給就一直是 `opacity` |
| `hoverOpacity` | 沒有 | 滑鼠在視窗上時改用這個不透明度,離開就回到上面兩個的規則。優先序:滑鼠在上面 > `behindOpacity` > `opacity`。視窗沒有焦點也算(在用別的視窗、游標滑過來);被別的程式的視窗擋住的地方不算。不重新載入頁面、不寫事件。細節見「滑鼠在上面時的不透明度」 |
| `frame` | `true` | 系統的標題列與邊框。`false` 就只剩內容:頁面裡標了 `data-float-drag` 的元素可以拖著移動,外圈 6 像素拖著改大小(收合時停用),關閉 / 縮小鈕自己畫(`float.close()` / `float.minimize()`) |
| `collapsed` | `false` | 收合成一個按鈕。頁面呼叫 `float.collapse()` / `float.expand()` 時輔助程式寫回來;也可以自己寫 `true` / `false`。見「收合成按鈕」 |
| `collapsedWidth`, `collapsedHeight` | 44 × 44 | 收合時的視窗大小,邏輯像素(小於 16 的當成 44) |
| `collapseAnchor` | `"top-right"` | 收合 / 還原時不動的那個角:`top-right`、`top-left`、`bottom-right`、`bottom-left` |
| `taskbar` | `false` | 要不要出現在工作列 |
| `minimized` | `false` | 縮小了沒。使用者縮小 / 還原時輔助程式寫回來;寫 `false` 就把縮小的視窗叫回來(不搶焦點) |

沒列出的欄位會被忽略,所以可以放自己的東西。

更新:把整個檔案寫成新的內容(不是只寫要改的欄位)。先讀回來再改,因為 `x` / `y` / `width` / `height` / `minimized` / `collapsed` 可能被輔助程式更新過(見下)。

### 滑鼠在上面時的不透明度(`hoverOpacity`)

```json
{ "opacity": 0.8, "behindOpacity": 0.35, "hoverOpacity": 1 }
```

- 由輔助程式自己看游標(有視窗設了 `hoverOpacity` 時,每 0.05 秒看一次),不經頁面也不經 mod:App 沒開、視窗沒有焦點都有效。
- 進來馬上變;離開要連續 0.15 秒在外面才變回去,所以擦過邊緣、快速進出不會閃。
- 「在上面」= 游標底下最上面的視窗是它。視窗被拖著走、收合(游標留在原處、按鈕在別處)、縮小之後,下一次看就不算在上面了;縮小是馬上不算。
- `clickThrough` 的視窗永遠不會是「游標底下的視窗」,改用視窗的矩形判斷(這時被別的視窗擋住也算)。
- 不寫任何事件、不重新載入頁面、不動 spec。

### 收合成按鈕(`collapsed`)

視窗縮成一個小按鈕(預設 44 × 44),再點一下回到原本的大小。整件事在輔助程式裡,App 沒開也能用。

- **`width` / `height` 永遠是展開時的大小**。收合時視窗是 `collapsedWidth` × `collapsedHeight`,不會寫進 `width` / `height`,也不會有 `resized` 事件。還原就是回到 `width` × `height`。
- **`x` / `y` 是視窗現在的左上角**:收合時就是按鈕的左上角。所以重開輔助程式 / App,按鈕在原地、仍是收合的。
- 收合時 `collapseAnchor` 那個角不動(預設右上角:按鈕留在原視窗的右上角);還原時也是同一個角不動,從按鈕現在的位置展開。按鈕被拖到別處,就在新位置展開。
- 還原後整個視窗會夾回按鈕所在的那個螢幕裡(按鈕在螢幕邊上時,視窗不會伸出去)。
- 收合時外圈 6 像素的改大小停用,視窗大小也被固定住(系統的邊框也拉不動)。
- 誰都可以收合 / 還原:頁面(`float.collapse()` / `float.expand()`,會寫事件 `collapsed` / `expanded` 並寫回 spec)或寫 spec 的人(把 `collapsed` 寫成 `true` / `false`;不寫事件,頁面一樣會被通知)。
- 寫 spec 還原時記得先讀回來:收合期間 `x` / `y` 已經是按鈕的位置。如果這次寫入同時改了 `x` / `y`,就以寫入的位置當作「還原前按鈕在哪」。
- 收合時改 `width` / `height`:只是記下來,還原時用新的大小。

## 頁面裡:`window.float`

輔助程式在每一頁的腳本之前注入:

```js
float.send(value)      // 傳一筆給外面:事件檔多一行 {"type":"message","data":value}
float.onData(fn)       // spec 的 data 每次改變時呼叫 fn(data);註冊時若已有資料會先叫一次
float.data             // 目前的 data
float.close()          // 關掉這個視窗(跟使用者按 × 一樣:事件 closed by user、spec 檔刪掉)
float.minimize()       // 縮小
float.collapse({ width: 44, height: 44 })   // 收合成這個大小的按鈕(不給就用 spec 的 collapsedWidth × collapsedHeight)
float.expand()         // 還原成收合前的大小
float.collapsed        // 現在是不是收合的
float.onCollapsed(fn)  // 註冊時馬上呼叫一次 fn(collapsed),之後每次改變(頁面、spec、重開輔助程式)再呼叫
```

收合時 `<html>` 會多一個 `data-float-collapsed` 屬性,只靠 CSS 就能換成按鈕的樣子:

```html
<style>
  #btn { display: none }
  html[data-float-collapsed] #full { display: none }
  html[data-float-collapsed] #btn  { display: block; width: 100%; height: 100% }
</style>
<div id="full">
  <div data-float-drag>Inbox <button onclick="float.collapse({ width: 44, height: 44 })">–</button></div>
  …
</div>
<button id="btn" data-float-drag-click onclick="float.expand()">✉</button>
```

`float.collapse()` / `float.expand()` 只是送出要求;真的換了才會叫 `onCollapsed`、才會有 `data-float-collapsed`。

沒有系統標題列(`frame: false`)時:

```html
<div data-float-drag>拖這一條移動視窗</div>   <!-- 裡面的 button / input / textarea / a 照常能按 -->
```

外圈 6 像素是改大小的把手(游標會變);收合時沒有。

拖曳的兩種寫法(有沒有系統標題列都能用):

| 屬性 | 按下去 | 用在 |
|---|---|---|
| `data-float-drag` | 馬上開始拖視窗。裡面的 `button` / `input` / `textarea` / `select` / `a` 不拖,照常能按 | 標題列那一條 |
| `data-float-drag-click` | 先等:游標移動滿 4 像素才開始拖視窗(這次就不會有 click);沒移動就放開,是一般的 click。可以直接標在 `button` 上 | 又要能拖又要能按的東西(收合後的按鈕) |

兩種都可以用 `data-float-nodrag` 把裡面的某一塊排除。`data-float-drag-click` 拖動時,視窗會比游標少走開頭那幾像素(門檻)。

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
| `closed` | `by`: `"user"` 或 `"spec"` | 視窗關了。`user` = 使用者按了關閉(或頁面呼叫 `float.close()`);`spec` = spec 檔被刪掉 |
| `minimized` / `restored` | | 視窗縮小 / 還原了(spec 的 `minimized` 同時寫回) |
| `collapsed` / `expanded` | `x`, `y`, `width`, `height` | 頁面呼叫了 `float.collapse()` / `float.expand()`:視窗現在的位置與大小(spec 的 `collapsed` / `x` / `y` 同時寫回)。這次的位置、大小改變不會另外有 `moved` / `resized`。寫 spec 造成的收合 / 還原沒有事件 |
| `warning` | `message` | 做不到但不影響其他功能(例:這個平台不支援點穿) |
| `error` | `message` | spec 解析不了、視窗開不起來、頁面載不進去 |

讀的人自己記「處理到哪個 `seq`」,下次只處理比它大的。

- 檔案超過 256 KiB 時,輔助程式會只留最後 200 行(`seq` 不變)。
- 如果看到最後一行的 `seq` 比自己記的還小,代表檔案被人重建了,從頭讀。

輔助程式會跟著改 spec 檔的兩種情況:

- 使用者**移動 / 改大小 / 縮小 / 還原**:把新的 `x` / `y` / `width` / `height` / `minimized` 寫回 spec 檔(其他欄位照舊)。收合時不寫 `width` / `height`。
- **收合 / 還原**(頁面或 spec):寫回 `collapsed`、新的 `x` / `y`;收合時另外寫 `collapsedWidth` / `collapsedHeight`(頁面可能指定了大小)。
- 使用者**關掉視窗**:刪掉 spec 檔。所以「spec 檔還在不在」就是「視窗還開著嗎」。

## 平台

| | Linux Mint(X11) | Windows |
|---|---|---|
| webview | WebKitGTK(`libwebkit2gtk-4.1`) | WebView2(Windows 11 內建) |
| 置頂 | ✅(`_NET_WM_STATE_ABOVE`) | ✅ |
| 點穿 | ✅ | ✅ |
| 半透明(`opacity`) | ✅ 要有合成器(Mint MATE 的 Marco 驗過) | 寫了,還沒在 Windows 上跑過 |
| 滑鼠在上面(`hoverOpacity`) | ✅ X11(Xvfb + Marco 驗過) | 寫了,還沒在 Windows 上跑過 |
| 收合成按鈕 | ✅(Xvfb + Marco 驗過) | 寫了,還沒在 Windows 上跑過。Windows 的視窗有系統最小寬度(沒標題列的也有,約 120 邏輯像素),收合時輔助程式把視窗的最小 / 最大尺寸都設成按鈕的大小(tao 用它回答 `WM_GETMINMAXINFO`),理論上就能小到 44;如果實際做不到,按鈕會比較寬,但角落照實際大小對齊、`width` / `height` 不受影響 |
| Wayland | 不保證置頂;`hoverOpacity` 不保證有效 | — |

## 建置

```sh
cd tools/k-float && cargo build --release     # 產出 target/release/k-float(.exe);install.sh 會幫你跑
tools/k-float/tests/smoke.sh                  # Linux:在測試環境的 Xvfb :99 跑一輪
tools/k-float/tests/wm.sh                     # Linux:自己開 Xvfb + marco,驗要視窗管理員的(透明度、拖曳、收合 / 還原…);要 python3-xlib、marco
powershell -NoProfile -ExecutionPolicy Bypass -File tools\k-float\tests\smoke.ps1   # Windows:在互動桌面跑(不要經 ssh),會開一個小視窗約 25 秒,不送鍵鼠
K_FLOAT_DISPLAY=:0 tools/k-float/tests/desktop.sh   # Linux:在實體桌面驗置頂 / 移動 / 使用者關窗(會開一個小視窗約 10 秒)
```

Linux 建置需要 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`。
