use rusqlite::{params, Connection};
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;

struct DbState {
    conn: Mutex<Connection>,
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
        .setup(|app| {
            let conn = init_database(app.handle())?;
            app.manage(DbState {
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![load_document, save_document]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
