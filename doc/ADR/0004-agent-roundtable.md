# ADR 0004:多 agent 討論群(主席制,mod `k-chat`)

- 狀態:Proposed
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
| skill / plugin | 讓 Claude Code session 也能開討論、邀人;主席的規則 | my-claude-plugins |

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

## 待決

1. 主席用哪個模型?用快的模型(例如 Haiku)可以省時間,但判斷可能比較差。
2. 主持程式用什麼寫(Node 或 Python),放在這個 repo 的 `tools/`,還是放在 plugin 裡?
3. 結論裡的待辦,要不要讓主席直接開 Tide 卡?
