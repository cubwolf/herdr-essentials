#!/bin/bash
# 安裝 herdr-essentials 的 mod 到 Herdr App home,並做一份 k-main layout(= 你的 main,換成 k-tabs / k-spaces)。
# 用法:./install.sh            (預設 home ~/.config/herdr-app;HERDR_APP_HOME 可改)
# 之後:herdr-app do layout.switch --name k-main     回原樣:layout.switch --name main
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
H=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
[ -d "$H/layouts" ] || { echo "找不到 $H/layouts:先開過一次 Herdr App" >&2; exit 1; }
for m in "$HERE"/mods/*/; do
  name=$(basename "$m"); mkdir -p "$H/mods/$name"; cp -r "$m". "$H/mods/$name/"; echo "mod: $name"
done
if [ -e "$H/layouts/k-main.json" ]; then
  echo "layout: k-main.json 已存在,不覆蓋(要重做請先自己刪掉)"
else
  sed -E 's/"mod": *"tabs"/"mod": "k-tabs"/; s/"mod": *"spaces"/"mod": "k-spaces"/' "$H/layouts/main.json" > "$H/layouts/k-main.json"
  grep -q '"k-tabs"' "$H/layouts/k-main.json" && grep -q '"k-spaces"' "$H/layouts/k-main.json" \
    || { echo "layout: main.json 裡找不到 tabs / spaces block,k-main.json 可能沒換到,請手動檢查" >&2; exit 1; }
  echo "layout: k-main.json"
fi
command -v herdr-app >/dev/null && for m in "$HERE"/mods/*/; do herdr-app check "$H/mods/$(basename "$m")" 2>&1 | grep -v libEGL; done
