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
if [ -e "$H/layouts/k-main.json" ]; then
  echo "layout: k-main.json 已存在,不覆蓋(要重做請先自己刪掉)"
else
  sed -E 's/"mod": *"tabs"/"mod": "k-tabs"/; s/"mod": *"spaces"/"mod": "k-spaces"/' "$H/layouts/main.json" > "$H/layouts/k-main.json"
  grep -q '"k-tabs"' "$H/layouts/k-main.json" && grep -q '"k-spaces"' "$H/layouts/k-main.json" \
    || { echo "layout: main.json 裡找不到 tabs / spaces block,k-main.json 可能沒換到,請手動檢查" >&2; exit 1; }
  echo "layout: k-main.json"
fi
command -v herdr-app >/dev/null && for m in "$HERE"/mods/*/; do herdr-app check "$H/mods/$(basename "$m")" 2>&1 | grep -v libEGL; done
