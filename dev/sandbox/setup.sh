#!/bin/bash
# 第一次:不用 sudo,把 Xvfb / xdotool 從 apt 下載解到 $SB/root(不動系統)。Ubuntu / Debian。
source "$(dirname "$0")/env.sh"
mkdir -p "$SB"/{pkgs,root,run,config,data,state,cache}; chmod 700 "$SB/run"
cd "$SB/pkgs" && apt-get download xvfb xdotool libxdo3
for f in "$SB"/pkgs/*.deb; do dpkg -x "$f" "$SB/root"; done
ldd "$SB/root/usr/bin/Xvfb" | grep "not found" && echo "缺上面的函式庫,一樣用 apt-get download 補" || echo "ok: $SB/root/usr/bin/{Xvfb,xdotool}"
