use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

struct DbState {
    conn: Mutex<Connection>,
}

struct LaunchPathState {
    path: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedExternalFile {
    path: String,
    content: String,
    read_only: bool,
    base_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImage {
    data: String,
    mime_type: String,
}

fn is_supported_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(ext.as_str(), "md" | "markdown" | "txt")
        })
        .unwrap_or(false)
}

fn normalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("svg") => Some("image/svg+xml"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        Some("avif") => Some("image/avif"),
        _ => None,
    }
}

fn first_supported_path(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .find(|path| path.is_file() && is_supported_text_extension(path))
        .map(|path| normalize_path(&path))
}

#[tauri::command]
fn load_document(state: State<'_, DbState>) -> Result<String, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|err| format!("failed to lock database: {err}"))?;

    let mut stmt = conn
        .prepare("SELECT content FROM documents WHERE id = 1")
        .map_err(|err| format!("failed to prepare load query: {err}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|err| format!("failed to query document: {err}"))?;

    if let Some(row) = rows
        .next()
        .map_err(|err| format!("failed to read row: {err}"))?
    {
        row.get(0)
            .map_err(|err| format!("failed to parse content: {err}"))
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
fn save_document(content: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state
        .conn
        .lock()
        .map_err(|err| format!("failed to lock database: {err}"))?;

    conn.execute(
        "INSERT INTO documents (id, content, updated_at)
         VALUES (1, ?1, datetime('now'))
         ON CONFLICT(id)
         DO UPDATE SET
           content = excluded.content,
           updated_at = datetime('now')",
        params![content],
    )
    .map_err(|err| format!("failed to save document: {err}"))?;

    Ok(())
}

#[tauri::command]
fn take_pending_launch_path(state: State<'_, LaunchPathState>) -> Result<Option<String>, String> {
    let mut pending = state
        .path
        .lock()
        .map_err(|err| format!("failed to lock pending launch path: {err}"))?;
    Ok(pending.take())
}

#[tauri::command]
fn open_external_file(path: String) -> Result<OpenedExternalFile, String> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err("file not found".to_string());
    }
    if !candidate.is_file() {
        return Err("path is not a file".to_string());
    }
    if !is_supported_text_extension(&candidate) {
        return Err("unsupported file type, only md/markdown/txt are allowed".to_string());
    }

    let content =
        std::fs::read_to_string(&candidate).map_err(|err| format!("failed to read file: {err}"))?;
    let metadata = std::fs::metadata(&candidate)
        .map_err(|err| format!("failed to read file metadata: {err}"))?;

    let normalized_path = normalize_path(&candidate);
    let base_dir = Path::new(&normalized_path)
        .parent()
        .map(normalize_path)
        .unwrap_or_default();

    Ok(OpenedExternalFile {
        path: normalized_path,
        content,
        read_only: metadata.permissions().readonly(),
        base_dir,
    })
}

#[tauri::command]
fn read_local_image(base_dir: String, image_path: String) -> Result<LocalImage, String> {
    let base_dir = PathBuf::from(base_dir)
        .canonicalize()
        .map_err(|err| format!("failed to resolve document directory: {err}"))?;
    let relative_path = PathBuf::from(image_path);
    if relative_path.is_absolute() {
        return Err("absolute image paths are not allowed".to_string());
    }

    let image_path = base_dir
        .join(relative_path)
        .canonicalize()
        .map_err(|err| format!("failed to resolve image: {err}"))?;
    if !image_path.starts_with(&base_dir) {
        return Err("image path must stay inside the document directory".to_string());
    }
    if !image_path.is_file() {
        return Err("image path is not a file".to_string());
    }

    let mime_type =
        image_mime_type(&image_path).ok_or_else(|| "unsupported image type".to_string())?;
    let data = std::fs::read(&image_path).map_err(|err| format!("failed to read image: {err}"))?;

    Ok(LocalImage {
        data: STANDARD.encode(data),
        mime_type: mime_type.to_string(),
    })
}

fn init_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|err| format!("failed to create app data dir: {err}"))?;

    let db_path = app_data_dir.join("editor.db");
    let conn = Connection::open(db_path).map_err(|err| format!("failed to open sqlite: {err}"))?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS documents (
           id INTEGER PRIMARY KEY,
           content TEXT NOT NULL,
           updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .map_err(|err| format!("failed to initialize sqlite schema: {err}"))?;

    Ok(conn)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_supported_path(&argv) {
                let state: State<'_, LaunchPathState> = app.state();
                if let Ok(mut pending) = state.path.lock() {
                    *pending = Some(path.clone());
                }
                let _ = app.emit("open-file-from-cli", path);
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let conn = init_database(app.handle())?;
            app.manage(DbState {
                conn: Mutex::new(conn),
            });
            app.manage(LaunchPathState {
                path: Mutex::new(first_supported_path(&std::env::args().collect::<Vec<_>>())),
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_document,
            save_document,
            take_pending_launch_path,
            open_external_file,
            read_local_image
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
