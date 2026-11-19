# 隔離測試環境(Linux)

在不碰你正在用的 Herdr App / herdr-core 的前提下試 mod:另起一個 herdr-core、另一個 App home、畫在虛擬螢幕 Xvfb `:99`。

```sh
dev/sandbox/setup.sh                 # 第一次:下載 Xvfb / xdotool 到 ~/.local/share/herdr-sandbox(不用 sudo)
dev/sandbox/up.sh                    # 起 Xvfb + 測試 App(core 會在第一次 hc 呼叫時自己起)
env -i HOME=$HOME PATH=$PATH bash -c 'source dev/sandbox/env.sh; herdr-app status; herdr-app shot /tmp/s.png'
dev/sandbox/down.sh                  # 收掉測試 App 與 Xvfb
```

- 隔離靠 `XDG_RUNTIME_DIR` / `XDG_CONFIG_HOME` 等環境變數:core 的 socket 落在 `$SB/run`,所以 `hc` 連到的是測試 core。**每次都用 `env -i … source env.sh`**,別把 env.sh source 進你平常的 shell。
- 驗證有隔離:測試環境的 `hc server status` 的 `core.id` / `pid` 要跟平常的不一樣。
- 點擊用 `xdotool`(只對 `DISPLAY=:99`)。
- 畫圖走 lavapipe(CPU 版 Vulkan),慢但夠截圖。
- 測試 core 不會自己停;要收就在測試環境裡 `hc server stop`(只影響測試 core)。
