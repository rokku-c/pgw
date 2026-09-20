#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Native shell for Personal Gateway.
//!
//! The window is a webview pointed at the gateway's *own* local HTTP server —
//! there is no bundled frontend to serve, and no Tauri IPC surface. This process
//! only has two jobs: make sure a gateway is listening, and open a window on it.
//!
//! The gateway binary is shipped as a Tauri sidecar (see `bundle.externalBin`),
//! so the `.app` is self-contained and does not depend on `pgw` being on `PATH` —
//! a double-clicked macOS app inherits a minimal `PATH` and would not find it.

use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 7210;
const READY_TIMEOUT: Duration = Duration::from_secs(25);

/// Handles to the gateway we started, if we started one. `None` means an
/// already-running gateway (started by `pgw open`, or a second window) is being
/// reused and must not be killed on exit.
struct Gateway(Mutex<Option<CommandChild>>);

fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("PGW_HOME") {
        return PathBuf::from(home);
    }
    let base = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".personal-gateway")
}

fn port() -> u16 {
    std::env::var("PGW_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// A plain TCP connect is enough to answer "is something listening yet" — cheaper
/// and dependency-free compared to issuing an authenticated HTTP request.
fn gateway_up(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(300)).is_ok()
}

/// The admin bearer token is the raw 32 bytes of `admin.key`, base64url-encoded
/// without padding — the same derivation as `config.ts`'s `toString("base64url")`.
/// Reading it here is what lets the window land on an authenticated URL.
fn admin_token() -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(home_dir().join("admin.key"))
        .ok()?
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() != 32 {
        return None;
    }
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = port();

            // Reuse a gateway that is already listening. The server takes an
            // exclusive lock on PGW_HOME, so a second `__serve` would exit
            // immediately anyway — spawning one here would just add a dead
            // process and a confusing race.
            let child: Option<CommandChild> = if gateway_up(port) {
                None
            } else {
                let (mut events, child) = app.shell().sidecar("pgw")?.args(["__serve"]).spawn()?;
                // Drain the sidecar's output; if the pipe fills up it blocks.
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = events.recv().await {
                        if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
                            eprintln!("[gateway] {}", String::from_utf8_lossy(&line));
                        }
                    }
                });
                Some(child)
            };

            let deadline = Instant::now() + READY_TIMEOUT;
            while !gateway_up(port) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(150));
            }

            app.manage(Gateway(Mutex::new(child)));

            let url = match admin_token() {
                Some(token) => format!("http://127.0.0.1:{port}/#token={token}"),
                None => format!("http://127.0.0.1:{port}/"),
            };
            let url: tauri::Url = url.parse()?;

            // The gateway's Host/Origin allowlist (`security.ts`) accepts exactly
            // `127.0.0.1:<port>`, so a same-origin webview passes unchanged.
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("Personal Gateway")
                .inner_size(1320.0, 860.0)
                .min_inner_size(880.0, 600.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Personal Gateway")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Gateway>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
