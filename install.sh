#!/bin/bash
# 安裝 herdr-essentials 的 mod 到 Herdr App home,並做一份 k-main layout(= 你的 main,換成 k-tabs / k-spaces)。
# 用法:./install.sh            預設 symlink:App home 的 mods/k-* 指到這個 repo,改 repo 即生效,直接 git commit
#      ./install.sh --copy     複製一份(Windows 沒開 symlink 權限時用);之後改動要重跑才會更新
#      (預設 home ~/.config/herdr-app;HERDR_APP_HOME 可改)
# 之後:herdr-app do layout.switch --name k-main     回原樣:layout.switch --name main
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
H=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
[ -d "$H/layouts" ] || { echo "找不到 $H/layouts:先開過一次 Herdr App" >&2; exit 1; }
MODE=link; [ "${1:-}" = "--copy" ] && MODE=copy
for m in "$HERE"/mods/*/; do
  name=$(basename "$m"); src=${m%/}; dst=$H/mods/$name
  if [ -L "$dst" ] || [ -d "$dst" ]; then rm -rf "$dst"; fi    # 不管之前是 copy 還是 link,都重做
  if [ "$MODE" = link ]; then ln -s "$src" "$dst"; echo "mod: $name -> $src"
  else mkdir -p "$dst"; cp -r "$src/." "$dst/"; echo "mod: $name (copy)"; fi
done
K=$H/layouts/k-main.json
if [ -e "$K" ]; then
  echo "layout: k-main.json 已存在,不重做;只補上新版的換法"
else
  sed -E 's/"mod": *"tabs"/"mod": "k-tabs"/; s/"mod": *"spaces"/"mod": "k-spaces"/' "$H/layouts/main.json" > "$K"
  grep -q '"k-tabs"' "$K" && grep -q '"k-spaces"' "$K" \
    || { echo "layout: main.json 裡找不到 tabs / spaces block,k-main.json 可能沒換到,請手動檢查" >&2; exit 1; }
  echo "layout: k-main.json"
fi
# k-chrome(左下多 Profiles、Mods 兩列):換掉 workspace-chrome,底部從 69px 加高到 125px 放得下四列;
# 舊版裝過的(97px,三列)補加高到 125px。重跑不會重複換。
if ! grep -q '"k-chrome"' "$K"; then
  sed -i.bak -E 's/"mod": *"workspace-chrome"/"mod": "k-chrome"/g; s/"px": *69([^0-9]|$)/"px": 125\1/' "$K" && rm -f "$K.bak"
  grep -q '"k-chrome"' "$K" && echo "layout: k-main 換成 k-chrome(Profiles、Mods)" || echo "layout: 找不到 workspace-chrome,Profiles / Mods 入口沒加上(用 herdr-app do mod.open --name k-profiles / k-mods 開)" >&2
elif grep -qE '"px": *97([^0-9]|$)' "$K"; then
  sed -i.bak -E 's/"px": *97([^0-9]|$)/"px": 125\1/' "$K" && rm -f "$K.bak"
  echo "layout: k-main 底部加高到 125px(多一列 Mods)"
fi
command -v herdr-app >/dev/null && for m in "$HERE"/mods/*/; do herdr-app check "$H/mods/$(basename "$m")" 2>&1 | grep -v libEGL; done
