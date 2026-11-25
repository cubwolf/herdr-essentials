# ADR 0004:多 agent 討論群(主席制,mod `k-chat`)

- 狀態:Accepted(2026-11-24 待決三題 Owner 已定,第一版已實作)
- 日期:2026-11-23
- 相關:Tide #293(本案)、#290(卡片式聊天視圖,讀 transcript,是另一件事;它原本也叫 k-chat,之後會改名)、kelp `doc/chat/`(chat plugin 的對話紀錄格式)、ADR 0003(視窗互相呼叫)

## 背景

想要一個像群組聊天的討論區,由 Owner 主持:
- 可以把各個 Herdr Space 的 agent 拉進來一起討論;
- 由一個主席 agent 決定誰先發言,避免大家搶話、亂成一團;
- 對話存在主 Space 的 repo 的 `doc/chat/` 底下。

Herdr 原生的 terminal 不適合拿來做這件事:每個 agent 都是一個互動式畫面,沒辦法輪流送話、也沒辦法統一收齊回答。所以改用無頭模式(`claude -p`)。

## 決定

### 架構:三塊

| 元件 | 負責 | 放哪 |
|---|---|---|
| 主持程式(runner) | 輪流:問主席 → 叫 agent 發言 → 寫入對話紀錄;收 Owner 的訊息 | 一支腳本,用 `hc run --keep` 跑在 herdr-core 裡:視窗關掉它也照跑,而且看得到、關得掉 |
| mod `k-chat`(畫面) | 顯示對話(監看 `doc/chat/<主題>.md`)、邀請 agent、Owner 發言(寫進收件匣檔) | Herdr App mod |
| skill / plugin | 讓 Claude Code session 也能開討論、邀人;主席的規則 | 本 repo `tools/k-chat/`(原本寫 my-claude-plugins,2026-11-24 改:之後要公開) |

為什麼不全放在 mod 裡:
- 視窗一關、版面一切,mod 就結束,討論會斷;
- `exec` 要等指令跑完才拿得到結果,看不到逐字輸出;
- 好幾個視窗同時開著時,可能會重複發言。

### 成員

- **邀請**:從 Space 選。被邀的 agent 在那個 Space 的機器、那個資料夾裡跑,讀得到那個 repo。
  - 可以選擇用 `--resume <那個 tab 的 session> --fork-session`,把 tab 裡的對話內容帶進來,不影響原本的 tab。
- **每個成員有自己的 session**:每輪用 `claude -p --resume <id>` 接續,自己的記憶不會斷。Codex 用 `codex exec resume`。
- **別台機器**:主持程式透過 herdr-core 在那台機器上跑(`hc run --on` / `exec on`)。回答統一由主持程式寫進主 repo 的對話紀錄。

### 主席

- 另一個 `claude -p`。每輪讀目前的對話紀錄和成員名單,輸出:
  `{ next: 成員, ask: 要問他什麼, yolo: true/false, done: true/false, reason }`
- Owner 發言時插隊優先;Owner 寫 `@某人` 就直接指定下一個發言的人。
- 有輪數上限,到了就由主席收尾。
- 結束時由主席寫結論,包含決定、待辦、誰負責。

### 權限:由主席決定什麼時候開 YOLO

- 預設**唯讀**:成員只能用讀檔、搜尋、查網頁之類的工具,只負責討論。
- 主席判斷要動手的時候(例如大家已經談定要實作),可以讓**某一個成員的某一輪**開 YOLO(`--dangerously-skip-permissions`)。
  - 對話紀錄裡要寫一行:`🔓 主席授權 <成員> YOLO:<理由>`,事後查得到。
  - 同一個 repo 一次只讓一個成員開 YOLO,避免兩個 agent 同時改同一份檔案。
  - 那一輪結束就收回,下一輪恢復唯讀。
- Owner 隨時可以否決:
  - 討論群設定裡有「允許主席開 YOLO」開關,預設開;
  - Owner 發言 `/stop` 就中止目前這一輪。

### 存檔

- 路徑:主 Space 的 repo 的 `doc/chat/<主題>.md`。
- 格式沿用 chat plugin:`## 🧑 Human · <時間>`、`## 🤖 <成員>@<space> · <時間>`,主席用 `## 🪑 主席 · <時間>`。porthole 的 `#chat` 可以直接顯示。
- 成員名單、session id、輪數另外存在 `doc/chat/<主題>.json`,主持程式重開後可以接著跑。

## 不選的做法

- **把話打進原本 tab 的互動畫面**(用 `hc send`):回答收不齊、也沒辦法知道對方什麼時候講完,而且會打斷那個 tab 本來在做的事。
- **全部放在 mod 裡跑**:理由見上面「為什麼不全放在 mod 裡」。
- **不設主席、大家自由發言**:每個 agent 都會回每一句話,很快就亂掉,token 也燒得快。

## 名稱(2026-11-23 Owner 決定)

- 這個討論群的 mod 叫 `k-chat`,比較貼切。
- #290 跟這個不一樣,是另一件事;它原本暫定的 `k-chat` 名稱不貼切,之後會換掉。

## 限制

- 每次發言都要重新啟動一次 `claude -p`,加上思考時間,一輪約 10 到 60 秒。比較像寄信來回,不像即時聊天。
- 成員開 YOLO 時,是在**它自己的 Space 的 repo** 裡動手,不是在主 repo。

## 待決 → 已決(2026-11-24,Owner)

1. **主席模型**:Sonnet,可在討論群設定改(`runner.mjs set <state> chair_model=…`,或 `new --chair-model`)。理由:主席要判斷何時開 YOLO,判斷錯的代價高。
2. **主持程式**:Node,放本 repo 的 `tools/k-chat/`(`runner.mjs` + `lib.mjs`,不用額外套件)。`install.sh` 把它連進 App home 的 `tools/k-chat`,mod 從那裡找。plugin 的 skill 之後只是呼叫它。
3. **待辦開卡**:主席不自動開。結論把待辦列成 `{title, repo, detail}` 存在 `<主題>.json`,mod 在結論下方列出來,Owner 勾選後按「開成 Tide 卡」,主持程式才用 `bin/task create` 建卡,並在紀錄寫一行 `🗂`。

## 實作後跟上面寫的不一樣的地方(第一版,2026-11-24)

- **紀錄的標題**:成員是 `## 🤖 Assistant · <成員>@<space> · <時間>`,主席是 `## 🤖 Assistant · 🪑 主席 · <時間>`。porthole 的 `#chat` 只認 `## 🧑 Human` 和 `## 🤖 Assistant` 開頭的標題,照原本寫的 `## 🤖 <成員>@<space>` / `## 🪑 主席` 會切不出訊息。成員回答裡自己的 `#` / `##` 標題會降成 `###`,免得被當成新訊息。
- **Owner 的訊息與設定都走收件匣**:`doc/chat/<主題>.inbox/`,一則一個小 JSON 檔(發言、邀請、設定、開卡、離開)。只有主持程式寫 `.md` 和 `.json`,視窗關掉重開、或同時開兩個視窗都不會寫壞。
- **從 mod 啟動主持程式**也是 `hc run --keep`(`runner.mjs start --no-layout`),但**不寫進排版**:每場討論在主 Space 有自己的 tab「💬 主題」(mod 當它唯一的 pane,`props.state` 指到狀態檔),側欄那一列點下去就是對話畫面。主持程式要停按 Stop host,沒在跑時發言或按 Resume 會再起來。(2026-11-24 改:第一版用 `tab.new` 開一個跑主持程式的 terminal tab,Kirin 試用時點側欄的「chat: …」只看到一串 log,回不到對話。)
- **mod 不能列資料夾**(`fs/promises` 只能讀授權過的位置),討論清單改問主持程式:`runner.mjs list --repo <dir>`。
- **多了幾個 Owner 指令**:`/end` 請主席現在收尾;主席可以把 next 填 `owner` 來等 Owner 回話;結束後 Owner 再發言會重新開始(至少再給 6 輪)。
- **唯讀怎麼做**:Claude Code 用 `--tools Read,Grep,Glob,WebFetch,WebSearch --allowedTools 同上 --strict-mcp-config`(連 MCP 都不載,免得成員用 MCP 工具寫東西);YOLO 那一輪改成 `--dangerously-skip-permissions`、不限工具。主席自己 `--tools ""`,什麼工具都沒有。

## 模型來源:Claude / Codex / Gemini(2026-11-24,Owner 要求)

主席和每位成員各自選來源,狀態檔記 `agent`(`claude` / `codex` / `gemini`)與 `model`(空 = 那個 CLI 的預設)。舊的狀態檔沒有這些欄,視為 Claude。

| 來源 | 跑什麼 | 唯讀輪 | YOLO 輪 | 接續 | 主席的 JSON |
|---|---|---|---|---|---|
| Claude | `claude -p --output-format json` | 只給讀的工具、不載 MCP | `--dangerously-skip-permissions` | `--resume` | `--json-schema` |
| Codex | `codex exec --json … -` | `--sandbox read-only` | `--dangerously-bypass-approvals-and-sandbox` | `resume <id>` | `--output-schema <檔>` |
| Gemini | `agy`,stdin / stdout 都是 `stream-json` | `--settings` 帶 deny 規則 + `--sandbox` + 主持程式盯著 | `--dangerously-skip-permissions` | `--conversation <id>` | `--json-schema` |

- **agy 的唯讀靠 deny 規則**(2026-11-24 用登入的 agy 1.5.16 實測後改):`--settings '{"permissions":{"deny":["write_file(*)","command(*)","unsandboxed(*)","mcp(*)","execute_url(*)","download_url(*)"]}}'`,只對那一次有效,不動使用者的設定檔;Deny 優先於模式與 Allow。實測:寫檔、改檔、跑指令、`run_workflow`、子代理都被拒,讀檔正常、有回答;YOLO 輪之後接續同一個對話,唯讀輪照樣被拒。
  - 不能用的:預設(auto)會寫檔跑指令;`"agentMode":""` 仍會在工作資料夾寫檔;`"toolPermission":"strict"` 連讀都拒、沒有回答;`--mode plan` 無頭時自動通過審查。
  - **第一版的防護是錯的**:以為 `init.permission_mode` 不是 `request-review` 就知道模式不對,其實 auto 也報 `request-review`,等於沒擋;已拿掉。
  - 沒有 `--settings` 的舊版 agy 會因不認得旗標而不跑(錯誤寫「太舊」)。主持程式仍盯輸出,看到寫檔 / 跑指令的工具成功就中止並記紀錄(最後一道,事後發現)。
- **agy 的提示走 stdin**(`--input-format stream-json`):紀錄最多 6 萬字,放在參數裡會超過上限。
- **Codex / Gemini 當主席時在一個空的暫存資料夾裡跑**:它們沒有「不給工具」的參數。Gemini 主席另外把讀檔 / 讀網頁也 deny(實測:讓它能讀,它會自己去翻檔,一次決定花了 224 秒),提示也直說不要用工具。
- **修掉一個錯**:`codex exec resume` 不收 `--sandbox`(只有 `--model`、`--json` 這類是全域參數),第一版把它放在 `resume` 後面;現在放前面。
- **模型名只收英數與 `._-:/@+[]`**,開頭要是英數:它會變成程式參數。

## skill / plugin 放哪(2026-11-24,Owner)

- 這個之後要公開,**不放 my-claude-plugins**(私人的);放本 repo。
- plugin 就是 `tools/k-chat/` 本身:`.claude-plugin/plugin.json` + `skills/k-chat/SKILL.md` + `commands/`(`new` / `say` / `invite` / `status`),跟 `runner.mjs` 同一個資料夾,所以裝起來是自足的(`${CLAUDE_PLUGIN_ROOT}/runner.mjs`)。repo 根目錄的 `.claude-plugin/marketplace.json` 把這個 repo 當 marketplace。
- 從 Claude Code 啟動主持程式用 `runner.mjs start`:`hc run --bg --keep --no-parent`(旗標都在 `--` 前、子程序拿掉 `TMUX` / `CLAUDECODE`),再把討論寫進 Herdr App 的排版(core 文件 `herdr-app`),是跟 mod 開的一樣的「💬 主題」tab。(2026-11-24 改:原本寫進去的是主持程式的 terminal,點了只看到 log。)

## 還沒做 / 已知限制

- 帶入 tab 的對話(`--resume <tab 的 session> --fork-session`):主持程式支援(成員 JSON 的 `fork` 欄),mod 的邀請畫面還沒有 —— mod 拿不到某個 tab 的 session 編號。
- Codex:參數照官方文件與原始碼寫,back 和 laptop 都沒裝,沒實測。Windows 上 npm 裝的 `codex.cmd` 會經過 cmd 啟動,也沒實測;別台 Windows 的 Codex 成員(`hc exec`)不確定叫不叫得起 `.cmd`。
- Gemini(agy):Linux 的 1.5.16 實測過(見「模型來源」)。沒測:Windows 與經 `hc exec` 到別台(`--settings` 的 JSON 引號);讀網頁的工具(`read_url`)在無頭時的行為。
- 主 Space 要在跑 Herdr App 的那台機器上(mod 只能在本機寫檔、起程式);成員可以在別台。
- 別台機器的成員走 `hc exec`,一輪最多 10 分鐘(本機 15 分鐘、YOLO 30 分鐘)。
- plugin 的指令(`/k-chat:new` 等)還沒在真的 Claude Code session 裡裝起來跑過;`claude plugin validate` 過了,`start` 在測試環境的 core 實跑過。
- 「開成 Tide 卡」只用假的 `task` 測過(`tests/k-chat.test.js`),沒有對真的 Tide 開過卡。

## 主席自己也說話(2026-11-26,Owner 要求)

- 原本主席只點名、不發表意見(提示寫明「你自己不發表意見」),Owner 叫它講看法它也不會講。
- 現在主席的輸出多一欄 `say`:回應 Owner、整理共識與分歧、指出漏掉的點、講自己的看法;三句以內,沒有就空字串。寫在紀錄裡點名那一則的前面(同一則訊息)。
- Owner 問的事主席自己答得了(不需要讀 repo)時,`say` 回答、`next` 填 `owner`,那一輪不叫成員。
- 主席仍然沒有工具、讀不到檔案;提示寫明要查證的事交給成員。
- `done: true` 那一輪的 `say` 不寫進紀錄(緊接著就是結論,實測內容重複)。
- 實測:真的 `claude -p`(Sonnet 主席 + 一位成員)跑過一場,主席先講看法再點名。Codex / Gemini 當主席沒實測這一欄。
