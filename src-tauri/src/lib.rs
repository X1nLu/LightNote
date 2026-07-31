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
}

fn is_supported_text_extension(path: &Path) -> bool {
    path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(ext.as_str(), "md" | "markdown" | "txt")
        })
        .unwrap_or(false)
}

fn normalize_path(path: &Path) -> String {
    path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
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

    let content = std::fs::read_to_string(&candidate)
        .map_err(|err| format!("failed to read file: {err}"))?;
    let metadata = std::fs::metadata(&candidate)
        .map_err(|err| format!("failed to read file metadata: {err}"))?;

    Ok(OpenedExternalFile {
        path: normalize_path(&candidate),
        content,
        read_only: metadata.permissions().readonly(),
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
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            load_document,
            save_document,
            take_pending_launch_path,
            open_external_file
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
