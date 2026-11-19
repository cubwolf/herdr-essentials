#!/bin/bash
# 起 Xvfb :99 + 測試 App(已起就跳過)。down.sh 收掉。
source "$(dirname "$0")/env.sh"
LD=$SB/root/usr/lib/x86_64-linux-gnu
pgrep -f "^$SB/root/usr/bin/Xvfb :99" >/dev/null || { LD_LIBRARY_PATH=$LD nohup $SB/root/usr/bin/Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >$SB/xvfb.log 2>&1 & sleep 1; }
running=0; for p in $(pgrep -x herdr-app); do grep -qz "HERDR_APP_HOME=$HERDR_APP_HOME" /proc/$p/environ 2>/dev/null && running=1; done
[ $running = 1 ] || { nohup herdr-app >$SB/app.log 2>&1 & }
