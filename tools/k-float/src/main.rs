//! k-float: opens always-on-top desktop windows from spec files.
//!
//!   k-float start <dir>   start a detached helper for <dir> (no-op if one is running), then exit
//!   k-float run <dir>     run in the foreground
//!   k-float stop <dir>    ask the helper for <dir> to exit
//!
//! <dir>/windows/<id>.json   one window (written by a mod, an agent or a script)
//! <dir>/events/<id>.jsonl   what happened to it (written here, one JSON object per line)
//! Protocol: doc/k-float-protocol.md

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{ResizeDirection, Window, WindowBuilder, WindowId};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const POLL: Duration = Duration::from_millis(200);
const SETTLE: Duration = Duration::from_millis(400);
const EVENTS_MAX_BYTES: u64 = 256 * 1024;
const EVENTS_KEEP_LINES: usize = 200;

/// Runs in every page before its own scripts (after `window.__floatFrameless` is set).
/// Messages that start with \u0001 are for the helper (move, resize, close, minimize), not the mod.
const PAGE_API: &str = r#"
(() => {
  const ctl = (c) => window.ipc.postMessage("\u0001" + c);
  window.float = {
    data: undefined,
    _fns: [],
    send(value) { window.ipc.postMessage(JSON.stringify(value === undefined ? null : value)); },
    onData(fn) { this._fns.push(fn); if (this.data !== undefined) fn(this.data); },
    close() { ctl("close"); },
    minimize() { ctl("minimize"); },
    __data(value) { this.data = value; for (const fn of this._fns) { try { fn(value); } catch (e) { console.error(e); } } },
  };
  // Without the system's frame the page is the whole window: elements marked data-float-drag move it,
  // and the outer few pixels resize it.
  const B = 6, CUR = { n: "ns", s: "ns", e: "ew", w: "ew", ne: "nesw", sw: "nesw", nw: "nwse", se: "nwse" };
  const edge = (e) => {
    if (!window.__floatFrameless) return "";
    const x = e.clientX, y = e.clientY;
    return (y < B ? "n" : y >= innerHeight - B ? "s" : "") + (x < B ? "w" : x >= innerWidth - B ? "e" : "");
  };
  let style = null;
  addEventListener("mousemove", (e) => {
    const d = edge(e), css = d ? `*{cursor:${CUR[d]}-resize !important}` : "";
    if (!style) { if (!css) return; style = document.createElement("style"); (document.head || document.documentElement).appendChild(style); }
    if (style.textContent !== css) style.textContent = css;
  }, true);
  addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const d = edge(e);
    if (d) { e.preventDefault(); e.stopPropagation(); ctl("resize:" + d); return; }
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest("[data-float-drag]") && !t.closest("button,input,textarea,select,a,[data-float-nodrag]")) {
      e.preventDefault(); ctl("drag");
    }
  }, true);
})();
"#;

fn page_api(frame: bool) -> String {
    format!("window.__floatFrameless = {};\n{PAGE_API}", !frame)
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Spec {
    html: String,
    data: Value,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    topmost: bool,
    click_through: bool,
    frame: bool,
    taskbar: bool,
    opacity: f64,
    /// Opacity while the person works in a window this one covers (it is not focused and the
    /// active window overlaps it). None: always `opacity`.
    behind_opacity: Option<f64>,
    /// Written here when the person minimizes the window; a mod sets it to false to bring it back.
    minimized: bool,
}

impl Default for Spec {
    fn default() -> Self {
        Spec {
            html: String::new(),
            data: Value::Null,
            title: "k-float".into(),
            x: None,
            y: None,
            width: 320.0,
            height: 240.0,
            topmost: true,
            click_through: false,
            frame: true,
            taskbar: false,
            opacity: 1.0,
            behind_opacity: None,
            minimized: false,
        }
    }
}

/// A screen's area in logical pixels: x, y, width, height.
type Area = (f64, f64, f64, f64);

/// The smallest width / height taken from a spec; below it the window would be lost.
const MIN_SIDE: f64 = 20.0;

/// Makes a spec's place one the person can see: a size too small to find (0×0) becomes the default,
/// and a place on no screen (Windows parks a minimized window at -32000, an older helper wrote that
/// into specs; a screen that was unplugged) moves to the middle of the first screen. True if changed.
fn fit(spec: &mut Spec, screens: &[Area]) -> bool {
    let d = Spec::default();
    let mut changed = false;
    if !(spec.width.is_finite() && spec.width >= MIN_SIDE) {
        spec.width = d.width;
        changed = true;
    }
    if !(spec.height.is_finite() && spec.height >= MIN_SIDE) {
        spec.height = d.height;
        changed = true;
    }
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        let (w, h) = (spec.width, spec.height);
        // At least a corner big enough to grab is on some screen.
        let seen = |&(sx, sy, sw, sh): &Area| {
            (x + w).min(sx + sw) - x.max(sx) >= w.min(40.0) && (y + h).min(sy + sh) - y.max(sy) >= h.min(MIN_SIDE)
        };
        if !(x.is_finite() && y.is_finite()) || (!screens.is_empty() && !screens.iter().any(seen)) {
            match screens.first() {
                Some(&(sx, sy, sw, sh)) => {
                    spec.x = Some((sx + (sw - w).max(0.0) / 2.0).round());
                    spec.y = Some((sy + (sh - h).max(0.0) / 2.0).round());
                }
                None => (spec.x, spec.y) = (None, None),
            }
            changed = true;
        }
    }
    changed
}

/// The screens, the primary one first.
fn screens(all: impl Iterator<Item = tao::monitor::MonitorHandle>, primary: Option<tao::monitor::MonitorHandle>) -> Vec<Area> {
    let area = |m: &tao::monitor::MonitorHandle| {
        let s = m.scale_factor();
        let (p, z) = (m.position(), m.size());
        (p.x as f64 / s, p.y as f64 / s, z.width as f64 / s, z.height as f64 / s)
    };
    let mut out: Vec<Area> = primary.iter().map(area).collect();
    for m in all {
        let a = area(&m);
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

enum UserEvent {
    /// The windows folder as it is now: id -> spec text. Sent only when something changed.
    Specs(HashMap<String, String>),
    Message(String, String),
    /// From the page to the helper: drag, resize:<n|s|e|w|ne|nw|se|sw>, close, minimize.
    Control(String, String),
    Loaded(String),
    Tick,
    Stop,
}

struct Float {
    id: String,
    spec: Spec,
    window: Window,
    webview: WebView,
    /// Position / size changed by the person; written out once they stop moving.
    moved: Option<Instant>,
    resized: Option<Instant>,
    focused: bool,
    /// The active window overlaps this one (only looked at while `behind_opacity` is set).
    behind: bool,
    /// The opacity the window has now (NaN: not set yet).
    shown: f64,
    warned: bool,
    /// When the spec last asked to minimize / restore: the window's state lags behind for a moment.
    minimize_asked: Option<Instant>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, dir) = match args.as_slice() {
        [c, d] if ["start", "run", "stop"].contains(&c.as_str()) => (c.as_str(), PathBuf::from(d)),
        [v] if v == "--version" || v == "-V" => {
            println!("k-float {VERSION}");
            return;
        }
        _ => {
            eprintln!("usage: k-float start|run|stop <dir>\n       k-float --version");
            std::process::exit(2);
        }
    };
    let result = match cmd {
        "start" => start(&dir),
        "stop" => fs::write(dir.join("stop"), "").map_err(|e| e.to_string()),
        _ => run(&dir),
    };
    if let Err(e) = result {
        eprintln!("k-float: {e}");
        std::process::exit(1);
    }
}

fn prepare(dir: &Path) -> Result<(), String> {
    for sub in ["windows", "events"] {
        fs::create_dir_all(dir.join(sub)).map_err(|e| format!("{}: {e}", dir.join(sub).display()))?;
    }
    Ok(())
}

/// The lock is held for as long as the helper runs; the OS drops it if the helper dies.
fn lock(dir: &Path) -> Result<Option<File>, String> {
    let path = dir.join("helper.lock");
    let file = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // Named in full: newer Rust has its own File::try_lock, older Rust doesn't.
    match fs4::FileExt::try_lock(&file) {
        Ok(()) => Ok(Some(file)),
        Err(_) => Ok(None),
    }
}

/// install.sh writes <dir>/paused while it rebuilds the helper (Windows can't replace a running
/// program): `start` doesn't start one meanwhile. Older than this, it was left behind by a failed run.
const PAUSE_MAX: Duration = Duration::from_secs(15 * 60);

fn start(dir: &Path) -> Result<(), String> {
    prepare(dir)?;
    let paused = fs::metadata(dir.join("paused")).and_then(|m| m.modified()).ok();
    if paused.is_some_and(|t| t.elapsed().map_or(true, |age| age < PAUSE_MAX)) {
        println!("paused");
        return Ok(());
    }
    match lock(dir)? {
        None => {
            println!("running");
            return Ok(());
        }
        Some(file) => drop(file),
    }
    let _ = fs::remove_file(dir.join("stop"));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = std::process::Command::new(exe);
    child.arg("run").arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(match File::create(dir.join("helper.log")) {
            Ok(f) => std::process::Stdio::from(f),
            Err(_) => std::process::Stdio::null(),
        });
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own session: it must outlive the `exec` that started it.
        unsafe {
            child.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A child inherits every inheritable handle, not just the three it is given: holding our
        // stdout would keep whoever ran `start` waiting for its end until the helper exits
        // (Herdr's exec did, 2026-11-24: 30 s, past its own timeout).
        no_inherit();
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Whoever ran `start` (Herdr's exec, hc exec) may end everything in its job when `start`
        // returns: leave the job. Not every job allows that; then start inside it.
        child.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if child.spawn().is_ok() {
            println!("started");
            return Ok(());
        }
        // The job doesn't let go (hc exec, 2026-11-24: a child started here died with `start`).
        // Ask Windows to start it instead (WMI): that process belongs to no one's job, and
        // still opens its windows on this desktop.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let quoted = |p: &Path| p.display().to_string().replace('\'', "''");
        let script = format!(
            // CreateFlags 8 (DETACHED_PROCESS), ShowWindow 0: no console window in front of the person.
            "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{CreateFlags=[uint32]8; ShowWindow=[uint16]0}}; (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='\"{}\" run \"{}\"'; ProcessStartupInformation=$s}}).ReturnValue",
            quoted(&exe),
            quoted(dir)
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("can't start the helper (powershell): {e}"))?;
        let answer = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if answer != "0" {
            return Err(format!("can't start the helper (WMI answered {answer:?}): {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        println!("started");
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        child.spawn().map_err(|e| format!("can't start the helper: {e}"))?;
        println!("started");
        Ok(())
    }
}

/// Keeps this process's stdin, stdout and stderr from being inherited by what it starts.
#[cfg(windows)]
fn no_inherit() {
    use std::os::windows::io::{AsRawHandle, RawHandle};
    const HANDLE_FLAG_INHERIT: u32 = 1;
    extern "system" {
        fn SetHandleInformation(handle: RawHandle, mask: u32, flags: u32) -> i32;
    }
    for handle in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
        if !handle.is_null() {
            // SAFETY: a handle this process owns; a bad one only makes the call fail.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
    }
}

fn run(dir: &Path) -> Result<(), String> {
    prepare(dir)?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let Some(mut lock_file) = lock(&dir)? else {
        return Err("another helper already runs for this folder".into());
    };
    let _ = lock_file.set_len(0);
    let _ = writeln!(lock_file, "{}", json!({ "pid": std::process::id(), "version": VERSION }));
    let _ = fs::remove_file(dir.join("stop"));

    let idle_exit = Duration::from_secs(
        std::env::var("K_FLOAT_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30),
    );

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    {
        let (dir, proxy) = (dir.clone(), proxy.clone());
        std::thread::spawn(move || watch(&dir, proxy));
    }

    let mut context = WebContext::new(Some(dir.join("webview")));
    let mut floats: HashMap<WindowId, Float> = HashMap::new();
    let mut bad: HashMap<String, String> = HashMap::new();
    let mut empty_since = Instant::now();

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep = &lock_file;
        match event {
            Event::UserEvent(UserEvent::Specs(texts)) => {
                // Gone from the folder: close.
                let gone: Vec<WindowId> = floats.iter().filter(|(_, f)| !texts.contains_key(&f.id)).map(|(w, _)| *w).collect();
                for w in gone {
                    if let Some(f) = floats.remove(&w) {
                        emit(&dir, &f.id, json!({ "type": "closed", "by": "spec" }));
                    }
                }
                bad.retain(|id, _| texts.contains_key(id));
                for (id, text) in texts {
                    let mut spec = match serde_json::from_str::<Spec>(&text) {
                        Ok(spec) => spec,
                        Err(e) => {
                            // A half-written file parses on a later pass; report each bad text once.
                            if bad.get(&id) != Some(&text) {
                                emit(&dir, &id, json!({ "type": "error", "message": format!("spec is not valid: {e}") }));
                                bad.insert(id, text);
                            }
                            continue;
                        }
                    };
                    bad.remove(&id);
                    if let Some(f) = floats.values_mut().find(|f| f.id == id) {
                        let fixed = fit(&mut spec, &screens(f.window.available_monitors(), f.window.primary_monitor()));
                        apply(&dir, f, spec);
                        if fixed {
                            refitted(&dir, f);
                        }
                    } else {
                        let fixed = fit(&mut spec, &screens(target.available_monitors(), target.primary_monitor()));
                        match open(target, &mut context, &proxy, &id, &spec) {
                            Ok(mut f) => {
                                if fixed {
                                    refitted(&dir, &f);
                                }
                                show_opacity(&dir, &mut f, false);
                                if spec.click_through {
                                    click_through(&dir, &f, true);
                                }
                                if spec.minimized {
                                    f.window.set_minimized(true);
                                    f.minimize_asked = Some(Instant::now());
                                }
                                floats.insert(f.window.id(), f);
                            }
                            Err(e) => emit(&dir, &id, json!({ "type": "error", "message": format!("can't open the window: {e}") })),
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Message(id, body)) => {
                let data = serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body));
                emit(&dir, &id, json!({ "type": "message", "data": data }));
            }
            Event::UserEvent(UserEvent::Control(id, cmd)) => {
                let Some(w) = floats.iter().find(|(_, f)| f.id == id).map(|(w, _)| *w) else { return };
                let f = &floats[&w];
                match cmd.as_str() {
                    "drag" => {
                        let _ = f.window.drag_window();
                    }
                    "minimize" => f.window.set_minimized(true),
                    "close" => user_closed(&dir, &mut floats, w),
                    c => {
                        if let Some(d) = c.strip_prefix("resize:").and_then(resize_direction) {
                            let _ = f.window.drag_resize_window(d);
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Loaded(id)) => {
                if let Some(f) = floats.values().find(|f| f.id == id) {
                    push_data(f);
                    emit(&dir, &id, json!({ "type": "ready" }));
                }
            }
            Event::UserEvent(UserEvent::Stop) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Tick) => {
                for f in floats.values_mut() {
                    settle(&dir, f);
                    sync_minimized(&dir, f);
                    let behind = f.spec.behind_opacity.is_some() && !f.focused && covered_by_active(f);
                    if behind != f.behind {
                        f.behind = behind;
                        show_opacity(&dir, f, false);
                    }
                }
                if floats.is_empty() {
                    if empty_since.elapsed() >= idle_exit {
                        *control_flow = ControlFlow::Exit;
                    }
                } else {
                    empty_since = Instant::now();
                }
            }
            Event::WindowEvent { window_id, event, .. } => match event {
                WindowEvent::CloseRequested => user_closed(&dir, &mut floats, window_id),
                WindowEvent::Focused(on) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.focused = on;
                        if on {
                            f.behind = false;
                        }
                        show_opacity(&dir, f, false);
                    }
                }
                WindowEvent::Moved(_) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.moved = Some(Instant::now());
                    }
                }
                WindowEvent::Resized(_) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.resized = Some(Instant::now());
                    }
                }
                _ => {}
            },
            _ => {}
        }
    });
}

/// The person closed the window (its × or the page's float.close()).
fn user_closed(dir: &Path, floats: &mut HashMap<WindowId, Float>, w: WindowId) {
    if let Some(f) = floats.remove(&w) {
        // Remove the spec first, so the next pass doesn't reopen it.
        let _ = fs::remove_file(dir.join("windows").join(format!("{}.json", f.id)));
        emit(dir, &f.id, json!({ "type": "closed", "by": "user" }));
    }
}

fn resize_direction(d: &str) -> Option<ResizeDirection> {
    Some(match d {
        "n" => ResizeDirection::North,
        "s" => ResizeDirection::South,
        "e" => ResizeDirection::East,
        "w" => ResizeDirection::West,
        "ne" => ResizeDirection::NorthEast,
        "nw" => ResizeDirection::NorthWest,
        "se" => ResizeDirection::SouthEast,
        "sw" => ResizeDirection::SouthWest,
        _ => return None,
    })
}

/// Polls the windows folder; a handful of small files, so this costs nothing and behaves the same everywhere.
fn watch(dir: &Path, proxy: EventLoopProxy<UserEvent>) {
    let windows = dir.join("windows");
    let mut seen: Option<HashMap<String, (SystemTime, u64)>> = None;
    loop {
        if dir.join("stop").exists() {
            let _ = fs::remove_file(dir.join("stop"));
            let _ = proxy.send_event(UserEvent::Stop);
            return;
        }
        let mut now = HashMap::new();
        if let Ok(entries) = fs::read_dir(&windows) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                if path.extension().and_then(|s| s.to_str()) != Some("json") || !valid_id(id) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    now.insert(id.to_string(), (meta.modified().unwrap_or(UNIX_EPOCH), meta.len()));
                }
            }
        }
        if seen.as_ref() != Some(&now) {
            let mut texts = HashMap::new();
            for id in now.keys() {
                // Unreadable right now (being replaced): an empty text fails to parse and is retried.
                // Windows PowerShell 5 writes UTF-8 with a byte order mark; JSON doesn't allow one.
                let text = fs::read_to_string(windows.join(format!("{id}.json"))).unwrap_or_default();
                texts.insert(id.clone(), text.trim_start_matches('\u{feff}').to_string());
            }
            // An empty or half-written file: look again on the next pass.
            let partial = texts.values().any(|t| serde_json::from_str::<Value>(t).is_err());
            seen = if partial { None } else { Some(now) };
            if proxy.send_event(UserEvent::Specs(texts)).is_err() {
                return;
            }
        }
        if proxy.send_event(UserEvent::Tick).is_err() {
            return;
        }
        std::thread::sleep(POLL);
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn open(
    target: &EventLoopWindowTarget<UserEvent>,
    context: &mut WebContext,
    proxy: &EventLoopProxy<UserEvent>,
    id: &str,
    spec: &Spec,
) -> Result<Float, String> {
    let mut builder = WindowBuilder::new()
        .with_title(&spec.title)
        .with_inner_size(LogicalSize::new(spec.width, spec.height))
        .with_always_on_top(spec.topmost)
        .with_decorations(spec.frame)
        .with_focused(false);
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        builder = builder.with_position(LogicalPosition::new(x, y));
    }
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowBuilderExtUnix;
        builder = builder.with_skip_taskbar(!spec.taskbar);
    }
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowBuilderExtWindows;
        builder = builder.with_skip_taskbar(!spec.taskbar);
    }
    let window = builder.build(target).map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        window.set_outer_position(LogicalPosition::new(x, y));
    }

    let (ipc_id, ipc_proxy) = (id.to_string(), proxy.clone());
    let (load_id, load_proxy) = (id.to_string(), proxy.clone());
    let webview_builder = WebViewBuilder::new_with_web_context(context)
        // A window that appears must not take the keyboard from what the person is typing in.
        .with_focused(false)
        .with_initialization_script(&page_api(spec.frame))
        .with_html(&spec.html)
        .with_ipc_handler(move |request| {
            let body = request.body();
            let event = match body.strip_prefix('\u{1}') {
                Some(cmd) => UserEvent::Control(ipc_id.clone(), cmd.to_string()),
                None => UserEvent::Message(ipc_id.clone(), body.clone()),
            };
            let _ = ipc_proxy.send_event(event);
        })
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(UserEvent::Loaded(load_id.clone()));
            }
        });
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or("the window has no container")?;
        webview_builder.build_gtk(vbox).map_err(|e| e.to_string())?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview_builder.build(&window).map_err(|e| e.to_string())?;

    Ok(Float {
        id: id.to_string(),
        spec: spec.clone(),
        window,
        webview,
        moved: None,
        resized: None,
        focused: false,
        behind: false,
        shown: f64::NAN,
        warned: false,
        minimize_asked: None,
    })
}

/// Brings an open window in line with a changed spec.
fn apply(dir: &Path, f: &mut Float, spec: Spec) {
    if spec == f.spec {
        return;
    }
    let old = std::mem::replace(&mut f.spec, spec);
    let spec = &f.spec;
    if spec.title != old.title {
        f.window.set_title(&spec.title);
    }
    if (spec.width, spec.height) != (old.width, old.height) {
        f.window.set_inner_size(LogicalSize::new(spec.width, spec.height));
    }
    if (spec.x, spec.y) != (old.x, old.y) {
        if let (Some(x), Some(y)) = (spec.x, spec.y) {
            f.window.set_outer_position(LogicalPosition::new(x, y));
        }
    }
    if spec.topmost != old.topmost {
        f.window.set_always_on_top(spec.topmost);
    }
    if spec.frame != old.frame {
        f.window.set_decorations(spec.frame);
        let _ = f.webview.evaluate_script(&format!("window.__floatFrameless = {}", !spec.frame));
    }
    if spec.minimized != old.minimized && spec.minimized != f.window.is_minimized() {
        f.window.set_minimized(spec.minimized);
        f.minimize_asked = Some(Instant::now());
    }
    if spec.click_through != old.click_through {
        click_through(dir, f, spec.click_through);
    }
    if spec.html != old.html {
        // The page reloads; Loaded pushes the data again.
        if let Err(e) = f.webview.load_html(&spec.html) {
            emit(dir, &f.id, json!({ "type": "error", "message": format!("can't load the page: {e}") }));
        }
    } else if spec.data != old.data {
        push_data(f);
    }
    if spec.behind_opacity.is_none() {
        f.behind = false;
    }
    // Last: on Windows the changes above rewrite the window's styles, and the see-through one with them.
    show_opacity(dir, f, cfg!(windows));
}

/// Takes the window's minimized state into the spec (the person minimized or restored it).
fn sync_minimized(dir: &Path, f: &mut Float) {
    if f.minimize_asked.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
        return;
    }
    f.minimize_asked = None;
    let now = f.window.is_minimized();
    if now != f.spec.minimized {
        f.spec.minimized = now;
        emit(dir, &f.id, json!({ "type": if now { "minimized" } else { "restored" } }));
        remember(dir, f);
    }
}

/// The opacity the window should have now: its `behindOpacity` while the person works in a window it
/// covers, else its `opacity`.
fn wanted_opacity(spec: &Spec, behind: bool) -> f64 {
    let v = match (behind, spec.behind_opacity) {
        (true, Some(b)) => b,
        _ => spec.opacity,
    };
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 }
}

fn show_opacity(dir: &Path, f: &mut Float, force: bool) {
    let value = wanted_opacity(&f.spec, f.behind);
    // A window never made see-through needs nothing (and on Windows stays out of layered mode).
    let unchanged = value == f.shown || (f.shown.is_nan() && value >= 1.0);
    // `force`: on Windows a style change drops the see-through setting; put it back.
    if unchanged && !(force && value < 1.0) {
        return;
    }
    f.shown = value;
    if !opacity(f, value) && value < 1.0 && !f.warned {
        f.warned = true;
        emit(dir, &f.id, json!({ "type": "warning", "message": "opacity is not supported here (the desktop doesn't blend windows): the window is opaque" }));
    }
}

/// The window the person is working in overlaps this one (desktop and taskbar don't count).
#[cfg(windows)]
fn covered_by_active(f: &Float) -> bool {
    use tao::platform::windows::WindowExtWindows;
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn GetClassNameW(hwnd: isize, name: *mut u16, len: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn IsIconic(hwnd: isize) -> i32;
    }
    let me = f.window.hwnd();
    // SAFETY: plain queries about window handles; a stale handle only makes them fail.
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 || fg == me || IsIconic(fg) != 0 {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            return false; // another of our windows
        }
        let mut name = [0u16; 64];
        let n = GetClassNameW(fg, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..n]);
        if ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class.as_str()) {
            return false;
        }
        let (mut a, mut m) = (Rect::default(), Rect::default());
        if GetWindowRect(fg, &mut a) == 0 || GetWindowRect(me, &mut m) == 0 {
            return false;
        }
        a.l < m.r && m.l < a.r && a.t < m.b && m.t < a.b
    }
}

#[cfg(target_os = "linux")]
fn covered_by_active(f: &Float) -> bool {
    use gtk::gdk::{self, WindowTypeHint};
    use gtk::glib::translate::{from_glib_full, ToGlibPtr};
    use gtk::prelude::{GtkWindowExt, WidgetExt};
    use tao::platform::unix::WindowExtUnix;
    let gw = f.window.gtk_window();
    let (Some(mine), Some(screen)) = (gw.window(), GtkWindowExt::screen(gw)) else { return false };
    // Deprecated in GTK 3.22 but still answers on X11 (from _NET_ACTIVE_WINDOW); gtk-rs dropped the wrapper.
    // SAFETY: the screen outlives the call; the result is a new reference (transfer full) or null.
    let active: Option<gdk::Window> = unsafe { from_glib_full(gdk::ffi::gdk_screen_get_active_window(screen.to_glib_none().0)) };
    let Some(active) = active else { return false };
    if active == mine || matches!(active.type_hint(), WindowTypeHint::Desktop | WindowTypeHint::Dock) {
        return false;
    }
    let (a, m) = (active.frame_extents(), mine.frame_extents());
    a.x() < m.x() + m.width() && m.x() < a.x() + a.width() && a.y() < m.y() + m.height() && m.y() < a.y() + a.height()
}

#[cfg(not(any(target_os = "linux", windows)))]
fn covered_by_active(_f: &Float) -> bool {
    false
}

fn push_data(f: &Float) {
    let _ = f.webview.evaluate_script(&format!("window.float && window.float.__data({})", f.spec.data));
}

/// Makes the whole window (page and frame alike) this see-through. False: the desktop can't.
/// The page can't do this itself with a transparent background: on WebKitGTK 2.52 a page that
/// repaints over a transparent window paints on top of its last frame, and is opaque within seconds.
fn opacity(f: &Float, value: f64) -> bool {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        use tao::platform::unix::WindowExtUnix;
        let window = f.window.gtk_window();
        window.set_opacity(value);
        // On X11 it takes a compositing manager; without one the window just stays opaque.
        window.screen().is_some_and(|s| s.is_composited())
    }
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        const GWL_EXSTYLE: i32 = -20;
        const WS_EX_LAYERED: isize = 0x0008_0000;
        const LWA_ALPHA: u32 = 2;
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
            fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
            fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
        }
        let hwnd = f.window.hwnd();
        // SAFETY: a window this process owns; a bad handle only makes the calls fail.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if style & WS_EX_LAYERED == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
            }
            SetLayeredWindowAttributes(hwnd, 0, (value * 255.0).round() as u8, LWA_ALPHA) != 0
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (f, value);
        false
    }
}

fn click_through(dir: &Path, f: &Float, on: bool) {
    if let Err(e) = f.window.set_ignore_cursor_events(on) {
        emit(dir, &f.id, json!({ "type": "warning", "message": format!("clickThrough is not supported here: {e}") }));
    }
}

/// Once the person stops dragging: say where the window is now, and remember it in the spec.
fn settle(dir: &Path, f: &mut Float) {
    if f.window.is_minimized() {
        // Windows parks a minimized window at -32000: not a place to remember.
        f.moved = None;
        f.resized = None;
        return;
    }
    let scale = f.window.scale_factor();
    let mut changed = false;
    if f.moved.is_some_and(|t| t.elapsed() >= SETTLE) {
        f.moved = None;
        // Linux without a frame: tao's outer position comes from the window manager's frame extents,
        // which for an undecorated window under marco are off by the title bar it doesn't have
        // (every save moved the window 30 px up). Moving it places the content, so read the content.
        let position = if cfg!(target_os = "linux") && !f.spec.frame { f.window.inner_position() } else { f.window.outer_position() };
        if let Ok(position) = position {
            let p: LogicalPosition<f64> = position.to_logical(scale);
            let (x, y) = (p.x.round(), p.y.round());
            if (Some(x), Some(y)) != (f.spec.x, f.spec.y) {
                f.spec.x = Some(x);
                f.spec.y = Some(y);
                emit(dir, &f.id, json!({ "type": "moved", "x": x, "y": y }));
                changed = true;
            }
        }
    }
    if f.resized.is_some_and(|t| t.elapsed() >= SETTLE) {
        f.resized = None;
        let s: LogicalSize<f64> = f.window.inner_size().to_logical(scale);
        let (w, h) = (s.width.round(), s.height.round());
        if (w, h) != (f.spec.width, f.spec.height) {
            f.spec.width = w;
            f.spec.height = h;
            emit(dir, &f.id, json!({ "type": "resized", "width": w, "height": h }));
            changed = true;
        }
    }
    if changed {
        remember(dir, f);
    }
}

/// The spec's place was one no one could see and `fit` changed it: write it back and say so, so a
/// mod that keeps the place (in its own storage) takes the new one.
fn refitted(dir: &Path, f: &Float) {
    if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
        emit(dir, &f.id, json!({ "type": "moved", "x": x, "y": y }));
    }
    emit(dir, &f.id, json!({ "type": "resized", "width": f.spec.width, "height": f.spec.height }));
    remember(dir, f);
}

/// Writes the window's place back into its spec file, keeping every other field as written.
fn remember(dir: &Path, f: &Float) {
    let path = dir.join("windows").join(format!("{}.json", f.id));
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(Value::Object(mut spec)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return };
    if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
        spec.insert("x".into(), json!(x));
        spec.insert("y".into(), json!(y));
    }
    spec.insert("width".into(), json!(f.spec.width));
    spec.insert("height".into(), json!(f.spec.height));
    if f.spec.minimized || spec.contains_key("minimized") {
        spec.insert("minimized".into(), json!(f.spec.minimized));
    }
    let tmp = dir.join("windows").join(format!("{}.json.tmp", f.id));
    if fs::write(&tmp, Value::Object(spec).to_string()).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// Appends one event. `seq` keeps counting across helper restarts; readers remember the last one they handled.
fn emit(dir: &Path, id: &str, mut event: Value) {
    let path = dir.join("events").join(format!("{id}.jsonl"));
    let old = fs::read_to_string(&path).unwrap_or_default();
    let last = old.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()?.get("seq")?.as_u64()).unwrap_or(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    event["seq"] = json!(last + 1);
    event["t"] = json!(t);
    let line = format!("{event}\n");
    if old.len() as u64 > EVENTS_MAX_BYTES {
        // Keep the tail: the file stays under what a mod can read in one go.
        let lines: Vec<&str> = old.lines().collect();
        let tail = lines[lines.len().saturating_sub(EVENTS_KEEP_LINES)..].join("\n");
        let tmp = dir.join("events").join(format!("{id}.jsonl.tmp"));
        if fs::write(&tmp, format!("{tail}\n{line}")).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(x: f64, y: f64, w: f64, h: f64) -> Spec {
        Spec { x: Some(x), y: Some(y), width: w, height: h, ..Spec::default() }
    }
    const SCREENS: [Area; 2] = [(0.0, 0.0, 1536.0, 864.0), (-1920.0, 0.0, 1920.0, 1080.0)];

    #[test]
    fn fit_keeps_a_place_on_a_screen() {
        for s in [spec(94.0, 600.0, 322.0, 34.0), spec(-1800.0, 50.0, 300.0, 200.0), spec(1480.0, 840.0, 300.0, 200.0)] {
            let mut t = s.clone();
            assert!(!fit(&mut t, &SCREENS), "{s:?}");
            assert_eq!(t, s);
        }
    }

    #[test]
    fn fit_brings_back_a_parked_window() {
        // Seen on the laptop: what an older helper wrote while the window was minimized (125%),
        // then Windows' smallest width for it.
        for (w, h) in [(0.0, 0.0), (120.0, 0.0)] {
            let mut t = spec(-25600.0, -25600.0, w, h);
            assert!(fit(&mut t, &SCREENS));
            assert!(t.width >= MIN_SIDE && t.height >= MIN_SIDE, "{t:?}");
            let (x, y) = (t.x.unwrap(), t.y.unwrap());
            assert!(x >= 0.0 && x + t.width <= 1536.0 && y >= 0.0 && y + t.height <= 864.0, "{t:?}");
        }
        let mut t = spec(-32000.0, -32000.0, 300.0, 200.0);
        assert!(fit(&mut t, &SCREENS));
        assert_eq!((t.x, t.y, t.width, t.height), (Some(618.0), Some(332.0), 300.0, 200.0));
    }

    #[test]
    fn fit_without_screens_only_fixes_the_size() {
        let mut t = spec(-25600.0, -25600.0, 0.0, 0.0);
        assert!(fit(&mut t, &[]));
        assert_eq!((t.x, t.y, t.width, t.height), (Some(-25600.0), Some(-25600.0), 320.0, 240.0));
        let mut t = Spec::default();
        assert!(!fit(&mut t, &SCREENS)); // no place: the system picks one
    }
}
