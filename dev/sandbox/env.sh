# herdr 隔離測試環境(Tide #286):獨立 core + 獨立 App home + Xvfb :99。用法:source env.sh
SB=${HERDR_SANDBOX:-$HOME/.local/share/herdr-sandbox}
unset TMUX CLAUDECODE HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SOCKET HC_SESSION HC_RUNTIME HC_SCOPE
export XDG_RUNTIME_DIR=$SB/run XDG_CONFIG_HOME=$SB/config XDG_DATA_HOME=$SB/data XDG_STATE_HOME=$SB/state XDG_CACHE_HOME=$SB/cache
export HERDR_APP_HOME=$SB/config/herdr-app DISPLAY=:99 DO_NOT_TRACK=1 HERDR_APP_NO_SOUND=1
unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
export PATH=$SB/root/usr/bin:$PATH LD_LIBRARY_PATH=$SB/root/usr/lib/x86_64-linux-gnu
