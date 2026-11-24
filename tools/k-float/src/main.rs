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
use tao::window::{Window, WindowBuilder, WindowId};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const POLL: Duration = Duration::from_millis(200);
const SETTLE: Duration = Duration::from_millis(400);
const EVENTS_MAX_BYTES: u64 = 256 * 1024;
const EVENTS_KEEP_LINES: usize = 200;

/// Runs in every page before its own scripts.
const PAGE_API: &str = r#"
window.float = {
  data: undefined,
  _fns: [],
  send(value) { window.ipc.postMessage(JSON.stringify(value === undefined ? null : value)); },
  onData(fn) { this._fns.push(fn); if (this.data !== undefined) fn(this.data); },
  __data(value) { this.data = value; for (const fn of this._fns) { try { fn(value); } catch (e) { console.error(e); } } },
};
"#;

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
        }
    }
}

enum UserEvent {
    /// The windows folder as it is now: id -> spec text. Sent only when something changed.
    Specs(HashMap<String, String>),
    Message(String, String),
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

fn start(dir: &Path) -> Result<(), String> {
    prepare(dir)?;
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
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        child.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    child.spawn().map_err(|e| format!("can't start the helper: {e}"))?;
    println!("started");
    Ok(())
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
                    let spec = match serde_json::from_str::<Spec>(&text) {
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
                        apply(&dir, f, spec);
                    } else {
                        match open(target, &mut context, &proxy, &id, &spec) {
                            Ok(f) => {
                                if spec.click_through {
                                    click_through(&dir, &f, true);
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
                WindowEvent::CloseRequested => {
                    if let Some(f) = floats.remove(&window_id) {
                        // Remove the spec first, so the next pass doesn't reopen it.
                        let _ = fs::remove_file(dir.join("windows").join(format!("{}.json", f.id)));
                        emit(&dir, &f.id, json!({ "type": "closed", "by": "user" }));
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
                texts.insert(id.clone(), fs::read_to_string(windows.join(format!("{id}.json"))).unwrap_or_default());
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
        .with_initialization_script(PAGE_API)
        .with_html(&spec.html)
        .with_ipc_handler(move |request| {
            let _ = ipc_proxy.send_event(UserEvent::Message(ipc_id.clone(), request.body().clone()));
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

    Ok(Float { id: id.to_string(), spec: spec.clone(), window, webview, moved: None, resized: None })
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
}

fn push_data(f: &Float) {
    let _ = f.webview.evaluate_script(&format!("window.float && window.float.__data({})", f.spec.data));
}

fn click_through(dir: &Path, f: &Float, on: bool) {
    if let Err(e) = f.window.set_ignore_cursor_events(on) {
        emit(dir, &f.id, json!({ "type": "warning", "message": format!("clickThrough is not supported here: {e}") }));
    }
}

/// Once the person stops dragging: say where the window is now, and remember it in the spec.
fn settle(dir: &Path, f: &mut Float) {
    let scale = f.window.scale_factor();
    let mut changed = false;
    if f.moved.is_some_and(|t| t.elapsed() >= SETTLE) {
        f.moved = None;
        if let Ok(position) = f.window.outer_position() {
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

/// Writes the window's place back into its spec file, keeping every other field as written.
fn remember(dir: &Path, f: &Float) {
    let path = dir.join("windows").join(format!("{}.json", f.id));
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(Value::Object(mut spec)) = serde_json::from_str::<Value>(&text) else { return };
    if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
        spec.insert("x".into(), json!(x));
        spec.insert("y".into(), json!(y));
    }
    spec.insert("width".into(), json!(f.spec.width));
    spec.insert("height".into(), json!(f.spec.height));
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
