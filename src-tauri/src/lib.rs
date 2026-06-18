// MWA desktop helper — a thin native shell (tray + window) around the local
// `mwa serve` process. On launch it starts the agent as a background "sidecar",
// waits for it to come up, then opens the chat window pointed at it. Closing the
// window hides it to the tray (the agent keeps running); Quit from the tray stops
// everything. Single-instance, auto-restarts the agent if it dies, auto-starts at
// login (quietly into the tray).
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

/// The background `mwa serve` child + a flag so the watchdog stops restarting it
/// once the user has quit.
struct AppState {
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

const SERVE_URL: &str = "http://localhost:7788";
const SERVE_ADDR: &str = "127.0.0.1:7788";

/// A writable per-user data dir for the agent's db / secrets / workspace (the
/// install dir under Program Files is read-only). Created if missing.
fn data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let d = app.path().app_data_dir().ok()?.join("data");
    let _ = std::fs::create_dir_all(&d);
    Some(d)
}

/// Append a line to the launch diagnostic (release builds have no console).
fn log_diag(app: &tauri::AppHandle, msg: &str) {
    if let Some(d) = data_dir(app) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(d.join("launch.log"))
        {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

/// Locate the bundled `runtime/` shipped with the installed app — next to the
/// executable (most reliable), or under the Tauri resource dir. None in dev.
fn bundled_runtime(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("runtime"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("runtime"));
    }
    for r in candidates {
        if r.join("node.exe").exists() && r.join("dist").join("cli.js").exists() {
            return Some(r);
        }
    }
    None
}

/// Start `mwa serve` as a background process (bundled runtime if installed, else dev).
fn spawn_sidecar(app: &tauri::AppHandle) -> std::io::Result<Child> {
    let mut data_env: Vec<(&str, String)> = vec![("MWA_NO_OPEN", "1".to_string())];
    if let Some(d) = data_dir(app) {
        data_env.push(("MWA_DB", d.join("agent.db").to_string_lossy().into_owned()));
        data_env.push(("MWA_WORKSPACE", d.join("workspace").to_string_lossy().into_owned()));
        data_env.push(("MWA_ENV_PATH", d.join(".env").to_string_lossy().into_owned()));
        data_env.push(("MWA_LOG", d.join("mwa.log").to_string_lossy().into_owned()));
    }

    if let Some(runtime) = bundled_runtime(app) {
        let node = runtime.join("node.exe");
        let entry = runtime.join("dist").join("cli.js");
        log_diag(app, &format!("[sidecar] bundled runtime: {}", runtime.display()));
        let mut cmd = Command::new(&node);
        cmd.arg(&entry).arg("serve").current_dir(&runtime);
        for (k, v) in &data_env {
            cmd.env(k, v);
        }
        hide_window(&mut cmd);
        let r = cmd.spawn();
        log_diag(
            app,
            &format!("[sidecar] spawn -> {:?}", r.as_ref().map(|c| c.id()).map_err(|e| e.to_string())),
        );
        return r;
    }

    // Dev fallback: system node + the repo build.
    log_diag(app, "[sidecar] no bundled runtime found — dev fallback");
    let root = std::env::var("MWA_APP_ROOT").unwrap_or_else(|_| ".".to_string());
    let node = std::env::var("MWA_NODE").unwrap_or_else(|_| "node".to_string());
    let entry = std::env::var("MWA_SERVE_ENTRY").unwrap_or_else(|_| "dist/cli.js".to_string());
    let mut cmd = Command::new(node);
    cmd.arg(entry)
        .arg("serve")
        .current_dir(root)
        .env("MWA_NO_OPEN", "1");
    hide_window(&mut cmd);
    cmd.spawn()
}

/// Launch the (console-app) Node sidecar with NO console window — this GUI app has no console
/// of its own, so Windows would otherwise pop a black command window for the child. CREATE_NO_WINDOW
/// makes it run silently in the background. No-op off Windows.
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// True once something is accepting connections on the serve port.
fn port_open() -> bool {
    match SERVE_ADDR.parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok(),
        Err(_) => false,
    }
}

/// Open (or focus) the chat window, loading the running sidecar's UI.
fn open_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(SERVE_URL.parse().expect("valid serve url")),
    )
    .title("MWA — Memory Working Agent")
    .inner_size(1040.0, 760.0)
    .min_inner_size(720.0, 560.0)
    .build();
}

/// Stop the agent for good (user quit): flag the watchdog off, kill the child.
fn stop(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        st.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut g) = st.child.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance MUST be the first plugin: a second launch just focuses the
        // running app's window instead of starting a second agent.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_main_window(app);
        }))
        // Run at login (quietly into the tray — see the --autostart flag below).
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Tray: Open + Quit. Left-click the icon to open the chat too.
            let open_i = MenuItem::with_id(app, "open", "Open MWA", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit MWA", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("MWA — Memory Working Agent")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_main_window(app),
                    "quit" => {
                        stop(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Register login auto-start for the installed (release) app only — keep dev clean.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // Start the agent and track it (watchdog restarts it if it dies).
            let child = spawn_sidecar(app.handle()).ok();
            app.manage(AppState {
                child: Mutex::new(child),
                shutting_down: AtomicBool::new(false),
            });

            let launched_at_login = std::env::args().any(|a| a == "--autostart");
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // 1) Wait for the sidecar, then open the window (unless launched at login).
                for _ in 0..240 {
                    if port_open() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if !launched_at_login {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || open_main_window(&h));
                }
                // 2) Watchdog: if the agent process dies, restart it (until the user quits).
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let st = handle.state::<AppState>();
                    if st.shutting_down.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut restart = false;
                    if let Ok(mut g) = st.child.lock() {
                        match g.as_mut() {
                            Some(c) => {
                                if matches!(c.try_wait(), Ok(Some(_))) {
                                    restart = true;
                                }
                            }
                            None => restart = true,
                        }
                    }
                    if restart && !st.shutting_down.load(Ordering::SeqCst) {
                        if let Ok(c) = spawn_sidecar(&handle) {
                            if let Ok(mut g) = st.child.lock() {
                                *g = Some(c);
                            }
                            log_diag(&handle, "[watchdog] agent was down — restarted");
                        }
                    }
                }
            });
            Ok(())
        })
        // Closing the window hides it to the tray; the agent keeps running.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                stop(handle);
            }
        });
}
