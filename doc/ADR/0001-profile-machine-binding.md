# ADR 0001:Profile 綁定 machine

- 狀態:Accepted(2026-11-22 實作,形式改成「每個視窗的隱藏清單」,見下方「決定」)
- 日期:2026-11-21
- 相關:`mods/k-settings/profiles.js`(Profiles 頁)、`mods/k-spaces`、`mods/k-agents`

## 背景

現在的結構:

- **Machine** 登記在本機的 herdr-core(`hc machine ls`),所有 profile 共用。目前有 This computer、`back`、`domi`、`laptop`。
- **Space** 掛在 machine 底下;每台 machine 的 core 保存自己的 space、tab、分割。
- **Profile** 只是另一個 App home(`~/.config/herdr-app-<名字>`),存版面、設定和這個視窗顯示中的 Space;terminal 是同一批,因為共用同一個 core。

所以每個 profile 視窗的側欄都列出所有 machine 的所有 space。machine 多、agent 多(例如 Idle 35 個)時,不同工作環境混在一起很難找。

想法:讓 machine 綁在 profile 上,一個視窗對應一組機器,切視窗就等於切工作環境,比較直觀。

## 提案

這是**顯示上的綁定**(篩選),不是把 machine 搬進 profile:

- 每個 profile 記一份「只顯示哪些 machine」,存在該 profile 自己的 `shared.json`(例如 key `k-profiles.machines`)。沒設 = 全部,也就是現在的行為。
- `k-spaces`:Spaces 列表只列綁定 machine 的 space。
- `k-agents`:Agents 列表只列綁定 machine 的 agent(見下方待決)。
- 新開 Space 時,預設開在綁定的 machine(綁多台時用第一台,或目前顯示中 space 的 machine)。
- Profiles 頁每一列多一個「Machines」多選,預設「全部」。只有勾了的 profile 才篩選,舊行為不受影響。

例:

| profile | 綁定 machine |
|---|---|
| default | This computer |
| work | back、domi |
| laptop | laptop |

## 要考慮的地方

- **不是隔離**:terminal 都在同一個 core,`hc`、命令面板、picker(內建 mod)仍看得到全部。picker 要一起篩選得再 clone 一份(`k-picker`)。
- **沒人綁的 machine 會消失**:某台沒綁到任何 profile,它的 space 就不出現在任何視窗。需要「顯示全部」的開關,或保留至少一個不篩選的 profile(例如 default 永遠不篩選)。
- **Settings → Machines**:傾向仍列全部,方便管理(新增、登入、改名、移除)。
- **Agents 提醒**:篩掉的 machine 的 agent 做完 / 卡住時,這個視窗的 Agents 列表看不到。Herdr 本身的通知 toast 應該仍會跳,要實測確認。
- **新 profile 的初始值**:新增 profile 時是複製目前視窗的 `shared.json`,綁定設定會被一起帶過去;要決定新 profile 是繼承還是重設為「全部」。

## 待決

1. Agents 列表要不要一起篩選?
2. picker 要不要 clone 一份一起篩選?
3. 沒綁到任何 profile 的 machine 怎麼處理(「顯示全部」開關 vs. default 永遠不篩選)?
4. 新 profile 繼承還是重設綁定?

## 相關想法(另案)

新增 profile 目前會複製目前視窗的 `layouts/`、`mods/`、`themes/`、`settings.json`、`shared.json` 等(見 `profiles.js` 的 `CARRY`)。可考慮:

- 「空白 profile」選項:只建資料夾和捷徑,不複製。
- 新 profile 的 k-* mod 改成 symlink 指到 repo,repo 更新時所有 profile 一起同步(目前推測 Windows 上 `Copy-Item` 會把 symlink 複製成實體檔案,未實測)。

## 決定(2026-11-22)

實作成**隱藏**而不是「綁定」:每個視窗(profile)各自記要藏哪些 machine / space,沒藏 = 全顯示。

- 存在該 profile 的 `shared.json`:`k-spaces.hidden = { machines: ["" (This computer) | 名字], spaces: [id] }`,`k-spaces.showHidden` 是「顯示隱藏」開關。
- 操作:機器標頭右鍵 → Hide / Unhide;Space 列右鍵 → Hide space / Unhide space。Spaces 標題右邊的眼睛圖示顯示藏了幾個,點一下把隱藏的半透明列出來(這時才能 Unhide),再點一下收起。
- 待決的答案:
  1. Agents 列表**不篩選**(先只藏 machine 和 space;要的話另案)。
  2. picker **不 clone**。
  3. 沒人綁的 machine 不會消失:預設全顯示,只有自己藏的才藏。
  4. 新 profile 會複製目前視窗的 `shared.json`,所以**繼承**隱藏設定;不要就在新視窗 Unhide。
- 新 Space:This computer 被藏時,Spaces 標題的「+」改開第一台沒被藏、已連線的機器的 repo 選單。
- Space 的右鍵選單改用 k-spaces 自己的(`mods/k-spaces/menu.js`),內建的 Rename / worktree / Close 都保留,另加 Copy path 和 Hide。
