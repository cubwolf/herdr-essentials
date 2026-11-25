#!/usr/bin/env python3
"""What needs a window manager: see-through while the person works in a window under it, opaque with
the focus, no title bar (drag / resize from the page, its own close and minimize), and minimize /
bring back. Run by wm.sh, which starts a private Xvfb + marco (compositing on) and sets DISPLAY.

    wm.py <k-float binary> [screenshot-prefix]
"""
import json, os, subprocess, sys, tempfile, time
from Xlib import X, Xatom, display, protocol
from Xlib.ext import xtest

BIN, SHOT = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
d = display.Display()
root = d.screen().root
A = lambda name: d.intern_atom(name)
D = tempfile.mkdtemp()
os.makedirs(f"{D}/windows")
fail = 0


def ok(m): print(f"ok   {m}")


def bad(m):
    global fail
    fail = 1
    print(f"FAIL {m}")


def check(m, cond): ok(m) if cond else bad(m)


def events():
    try:
        return [json.loads(l) for l in open(f"{D}/events/note.jsonl") if l.strip()]
    except FileNotFoundError:
        return []


def types(): return [e["type"] for e in events()]


def spec(): return json.load(open(f"{D}/windows/note.json"))


def write(s):
    json.dump(s, open(f"{D}/windows/note.json.tmp", "w"))
    os.replace(f"{D}/windows/note.json.tmp", f"{D}/windows/note.json")


def wait(cond, secs=4.0):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return cond()


def find(title):
    """The client window with this title (marco reparents it into a frame)."""
    def walk(w):
        try:
            name = w.get_full_property(A("_NET_WM_NAME"), A("UTF8_STRING"))
            if name and name.value.decode() == title:
                return w
            for c in w.query_tree().children:
                r = walk(c)
                if r:
                    return r
        except Exception:
            pass
        return None
    return walk(root)


def opacity(w):
    p = w.get_full_property(A("_NET_WM_WINDOW_OPACITY"), Xatom.CARDINAL)
    return round(p.value[0] / 0xFFFFFFFF, 2) if p else 1.0


def activate(w):
    ev = protocol.event.ClientMessage(window=w, client_type=A("_NET_ACTIVE_WINDOW"),
                                      data=(32, [2, X.CurrentTime, 0, 0, 0]))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.flush()


def active():
    p = root.get_full_property(A("_NET_ACTIVE_WINDOW"), Xatom.WINDOW)
    return p.value[0] if p else 0


def place(w):
    """Client window's top-left on the screen."""
    g = w.translate_coords(root, 0, 0)
    return -g.x, -g.y


def move_resize(w, x, y, width, height):
    w.configure(x=x, y=y, width=width, height=height)
    d.flush()


def mouse(x, y, press=None, release=None):
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    if press:
        xtest.fake_input(d, X.ButtonPress, 1)
    if release:
        xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()


def drag(x0, y0, x1, y1):
    mouse(x0, y0)
    time.sleep(0.3)
    mouse(x0, y0, press=True)
    time.sleep(0.4)
    for i in range(1, 11):
        mouse(x0 + (x1 - x0) * i // 10, y0 + (y1 - y0) * i // 10)
        time.sleep(0.05)
    time.sleep(0.2)
    mouse(x1, y1, release=True)


def shot(name):
    if SHOT:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "900x560",
                        "-i", os.environ["DISPLAY"], "-frames:v", "1", f"{SHOT}-{name}.png"])
        print(f"     shot: {SHOT}-{name}.png")


# A program the note sits on top of.
under = root.create_window(40, 40, 700, 460, 0, d.screen().root_depth, background_pixel=0x3a6ea5)
under.set_wm_name("under")
under.change_property(A("_NET_WM_NAME"), A("UTF8_STRING"), 8, b"under")
under.map()
d.sync()
time.sleep(0.8)

# The note: like k-note (no title bar, see-through while the person works in a window under it).
page = ("<!doctype html><style>html,body{margin:0;height:100%;background:#fff7c2;overflow:hidden}"
        "body{display:flex;flex-direction:column;font:14px sans-serif}"
        "#bar{height:22px;display:flex;justify-content:flex-end;gap:2px;padding:0 4px}"
        "#bar button{width:22px;height:18px;border:0;background:#f1e6a6}"
        "textarea{flex:1;border:0;background:transparent;padding:0 12px}</style>"
        "<div id=bar data-float-drag><button id=min>-</button><button id=x>x</button></div>"
        "<textarea>k-float note</textarea>"
        "<script>min.onclick=()=>float.minimize();x.onclick=()=>float.close()</script>")
if os.environ.get("K_FLOAT_WM_PAGE"):   # e.g. k-note's own page (its buttons sit at the same places)
    page = open(os.environ["K_FLOAT_WM_PAGE"]).read()
write({"title": "wm-note", "x": 200, "y": 150, "width": 280, "height": 200, "html": page,
       "frame": False, "opacity": 1, "behindOpacity": 0.35})
env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "CLAUDECODE")}
env["K_FLOAT_IDLE_SECS"] = "3"
out = subprocess.run([BIN, "start", D], env=env, capture_output=True, text=True).stdout.strip()
check(f"start ({out})", out == "started")
check("ready", wait(lambda: "ready" in types(), 8))
note = None
wait(lambda: find("wm-note") is not None)
note = find("wm-note")
check("window exists", note is not None)
if note is None:
    print(open(f"{D}/helper.log").read() if os.path.exists(f"{D}/helper.log") else "")
    sys.exit(1)
time.sleep(0.5)

# 1. No title bar: marco gives the window no frame decoration (its frame is the client's size).
nx, ny = place(note)
g = note.get_geometry()
check(f"no title bar (content at {nx},{ny}, asked 200,150)", abs(ny - 150) <= 2 and abs(nx - 200) <= 2)

# 2. The person works in the window under it: see-through.
activate(under)
check("under is active", wait(lambda: active() == under.id))
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through while the window under it is active ({opacity(note)})", r)
shot("behind")

# 3. The active window moves away from the note: opaque again.
move_resize(under, 600, 500, 250, 120)
r = wait(lambda: opacity(note) == 1.0)
check(f"opaque once the active window doesn't overlap ({opacity(note)})", r)
move_resize(under, 40, 40, 700, 460)
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through again when it overlaps ({opacity(note)})", r)

# 4. The note gets the focus: opaque.
mouse(nx + 100, ny + 120, press=True, release=True)   # click into the text
r = wait(lambda: opacity(note) == 1.0)
check(f"opaque with the focus ({opacity(note)})", r)
shot("focused")
# ... and back to see-through when the person goes back to the window under it.
activate(under)
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through again after leaving it ({opacity(note)})", r)

# 5. Drag the strip: the window moves and the spec remembers it.
drag(nx + 60, ny + 10, nx + 160, ny + 70)
check("moved by dragging the strip", wait(lambda: sum(t == "moved" for t in types()) >= 1 and abs(spec().get("x", 0) - 300) <= 3))
s = spec()
check(f"spec remembers the place ({s.get('x')},{s.get('y')}; expected 300,210)", abs(s.get("x", 0) - 300) <= 3 and abs(s.get("y", 0) - 210) <= 3)
check(f"the window is where the spec says ({place(note)})", abs(place(note)[0] - s["x"]) <= 3 and abs(place(note)[1] - s["y"]) <= 3)

# 6. Drag the bottom-right corner: resized.
nx, ny = place(note)
g = note.get_geometry()
drag(nx + g.width - 2, ny + g.height - 2, nx + g.width + 58, ny + g.height + 38)
check("resized from the corner", wait(lambda: "resized" in types()))
s = spec()
check(f"spec remembers the size ({s.get('width')}x{s.get('height')})", abs(s.get("width", 0) - 340) <= 4 and abs(s.get("height", 0) - 240) <= 4)

# 7. The page's minimize button; then bring it back from the spec.
nx, ny = place(note)
g = note.get_geometry()
mouse(nx + g.width - 40, ny + 10, press=True, release=True)   # "-" (left of "x")
check("minimized by the page's button", wait(lambda: "minimized" in types()))
check("spec says minimized", wait(lambda: spec().get("minimized") is True))
check("window is hidden", note.get_attributes().map_state != X.IsViewable)
s = spec(); s["minimized"] = False; write(s)
check("restored by the spec", wait(lambda: "restored" in types() or note.get_attributes().map_state == X.IsViewable))
check("window is shown again", wait(lambda: note.get_attributes().map_state == X.IsViewable))
time.sleep(2.5)   # past the grace period: the helper must not take the old state back
check("stays shown", note.get_attributes().map_state == X.IsViewable and spec().get("minimized") is False)
shot("restored")

# Close and reopen from the remembered spec: same place (no drift).
before = place(note)
s = spec()
os.remove(f"{D}/windows/note.json")
wait(lambda: find("wm-note") is None)
write(s)
wait(lambda: find("wm-note") is not None)
note = find("wm-note")
time.sleep(1.2)
after = place(note)
check(f"reopened at the same place ({before} -> {after})", abs(before[0] - after[0]) <= 2 and abs(before[1] - after[1]) <= 2)
check("spec not moved by reopening", abs(spec()["x"] - s["x"]) <= 2 and abs(spec()["y"] - s["y"]) <= 2)

# 8. The page's close button: closed by user, spec removed.
nx, ny = place(note)
g = note.get_geometry()
mouse(nx + g.width - 16, ny + 10, press=True, release=True)
check("closed by the page's button", wait(lambda: any(e["type"] == "closed" and e.get("by") == "user" for e in events())))
check("spec removed", not os.path.exists(f"{D}/windows/note.json"))
check("no warning", "warning" not in types())

subprocess.run([BIN, "stop", D], env=env)
if fail:
    print("--- events"); print("\n".join(json.dumps(e) for e in events()))
    print("--- log"); print(open(f"{D}/helper.log").read() if os.path.exists(f"{D}/helper.log") else "")
sys.exit(fail)
