#!/bin/bash
# 只收測試環境自己起的:App(靠 HERDR_APP_HOME 指到 sandbox 那個)與 Xvfb :99。不碰真 core / 真 App。
source "$(dirname "$0")/env.sh"
for p in $(pgrep -x herdr-app); do grep -qz "HERDR_APP_HOME=$HERDR_APP_HOME" /proc/$p/environ 2>/dev/null && kill $p; done
pkill -f "^$SB/root/usr/bin/Xvfb :99"
