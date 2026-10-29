mod secrets;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::task::AbortHandle;

#[derive(Debug, Deserialize)]
pub struct StreamRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: String,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub insecure_tls: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StreamEvent {
    Chunk {
        text: String,
    },
    End,
    Error {
        status: Option<u16>,
        message: String,
    },
}

/// Tracks in-flight requests so the UI can cancel them (undo / pause / new game).
#[derive(Default, Clone)]
pub struct AbortRegistry(pub Arc<Mutex<HashMap<String, AbortHandle>>>);

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

fn describe_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    truncate(&message, 2000)
}

/// One shared `reqwest::Client` per TLS mode: a fresh client per turn would
/// discard connection and TLS session reuse between AI moves.
fn shared_client(insecure: bool) -> Result<reqwest::Client, String> {
    static SECURE: OnceLock<reqwest::Client> = OnceLock::new();
    static INSECURE: OnceLock<reqwest::Client> = OnceLock::new();
    let cell = if insecure { &INSECURE } else { &SECURE };
    if let Some(client) = cell.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(insecure)
        .user_agent("ChessMind/1.0")
        .build()
        .map_err(|error| error.to_string())?;
    let _ = cell.set(client.clone());
    Ok(client)
}

/// Only https is accepted, plus plain http for loopback gateways (LM Studio,
/// Ollama, local proxies). This keeps the IPC bridge from becoming a generic
/// plaintext exfiltration channel if the WebView is ever compromised.
fn check_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("无效的接口地址：{error}"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let loopback = host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.ends_with(".localhost");
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        "http" => Err("出于安全考虑，只允许 https 接口（本机地址除外）".to_string()),
        other => Err(format!("不支持的协议：{other}")),
    }
}

/// Decode a byte stream incrementally. A chunk boundary can fall inside a
/// multi-byte UTF-8 character; decoding each chunk on its own would replace
/// the halves with U+FFFD and corrupt Chinese text.
fn drain_utf8(pending: &mut Vec<u8>, out: &mut String) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                return;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    if let Ok(text) = std::str::from_utf8(&pending[..valid]) {
                        out.push_str(text);
                    }
                    pending.drain(..valid);
                }
                match error.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..len);
                    }
                    // Incomplete character at the end: wait for the next chunk.
                    None => return,
                }
            }
        }
    }
}

async fn run_stream(id: String, request: StreamRequest, on_event: Channel<StreamEvent>) {
    let timeout_secs = request.timeout_secs.unwrap_or(180).clamp(10, 3600);

    if let Err(message) = check_url(&request.url) {
        let _ = on_event.send(StreamEvent::Error {
            status: None,
            message,
        });
        return;
    }

    let client = match shared_client(request.insecure_tls) {
        Ok(client) => client,
        Err(message) => {
            let _ = on_event.send(StreamEvent::Error {
                status: None,
                message,
            });
            return;
        }
    };

    let method_name = request.method.as_deref().unwrap_or("POST").to_uppercase();
    let method = reqwest::Method::from_bytes(method_name.as_bytes()).unwrap_or(reqwest::Method::POST);

    let mut builder = client
        .request(method, &request.url)
        .timeout(Duration::from_secs(timeout_secs));
    for (key, value) in &request.headers {
        // Hop-by-hop / transport headers are owned by reqwest and must not be
        // overridden by page-supplied values.
        let lower = key.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding" | "upgrade"
        ) {
            continue;
        }
        builder = builder.header(key.as_str(), value.as_str());
    }

    let response = match builder.body(request.body.clone()).send().await {
        Ok(response) => response,
        Err(error) => {
            let _ = on_event.send(StreamEvent::Error {
                status: error.status().map(|status| status.as_u16()),
                message: describe_error(&error),
            });
            return;
        }
    };

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            status: Some(status.as_u16()),
            message: truncate(&text, 4000),
        });
        return;
    }

    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                pending.extend_from_slice(&bytes);
                let mut text = String::new();
                drain_utf8(&mut pending, &mut text);
                if !text.is_empty() && on_event.send(StreamEvent::Chunk { text }).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = on_event.send(StreamEvent::Error {
                    status: None,
                    message: describe_error(&error),
                });
                return;
            }
        }
    }

    // Flush any trailing bytes (a truncated final character becomes U+FFFD).
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending).to_string();
        let _ = on_event.send(StreamEvent::Chunk { text });
    }
    let _ = id;
    let _ = on_event.send(StreamEvent::End);
}

#[tauri::command]
async fn llm_stream(
    id: String,
    request: StreamRequest,
    on_event: Channel<StreamEvent>,
    registry: State<'_, AbortRegistry>,
) -> Result<(), String> {
    let shared = registry.0.clone();
    let task_id = id.clone();
    let task = tokio::spawn(run_stream(task_id, request, on_event));
    // Register the abort handle synchronously so a fast cancel (undo / pause) works.
    if let Ok(mut map) = shared.lock() {
        map.insert(id.clone(), task.abort_handle());
    }
    let _ = task.await;
    // Always drop the entry, including every early-return path inside run_stream.
    if let Ok(mut map) = shared.lock() {
        map.remove(&id);
    }
    Ok(())
}

#[tauri::command]
fn llm_abort(id: String, registry: State<'_, AbortRegistry>) -> bool {
    let handle = registry.0.lock().ok().and_then(|mut map| map.remove(&id));
    match handle {
        Some(handle) => {
            handle.abort();
            true
        }
        None => false,
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn read_settings(app: AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    match secrets::open_settings(&raw) {
        Ok(plaintext) => Ok(Some(plaintext)),
        Err(error) => {
            // Never leave the user one save away from losing a settings file we
            // could not read (moved profile, corrupted blob). Keep it aside.
            if let Ok(stamp) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                let backup = path.with_extension(format!("json.unreadable-{}", stamp.as_secs()));
                let _ = std::fs::rename(&path, backup);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn write_settings(app: AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    // The document contains API keys: encrypt it for the current Windows user
    // before it touches the disk.
    let encoded = secrets::seal_settings(&json)?;
    // Write-then-rename so a crash mid-write cannot leave a truncated
    // settings.json behind (which would silently fall back to the defaults).
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, encoded).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, &path).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AbortRegistry::default())
        .invoke_handler(tauri::generate_handler![
            llm_stream,
            llm_abort,
            read_settings,
            write_settings,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running ChessMind");
}
