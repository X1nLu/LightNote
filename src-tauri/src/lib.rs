use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

struct LaunchPathState {
    path: Mutex<Option<String>>,
}

struct SpellcheckState {
    dictionary: Mutex<Option<spellbook::Dictionary>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedExternalFile {
    path: String,
    content: String,
    read_only: bool,
    base_dir: String,
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedExternalFile {
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImage {
    data: String,
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpellingIssue {
    from: usize,
    to: usize,
    word: String,
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

fn content_fingerprint(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
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

fn is_url_start(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://") || value.starts_with("www.")
}

fn check_spelling_line(
    line: &str,
    line_utf16_start: usize,
    dictionary: &spellbook::Dictionary,
    issues: &mut Vec<SpellingIssue>,
) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !line.is_char_boundary(index) {
            index += 1;
            continue;
        }
        if bytes[index] == b'`' {
            let delimiter_start = index;
            while index < bytes.len() && bytes[index] == b'`' {
                index += 1;
            }
            let delimiter = &line[delimiter_start..index];
            if let Some(end) = line[index..].find(delimiter) {
                index += end + delimiter.len();
            }
            continue;
        }

        if bytes[index] == b'<' {
            if let Some(end) = line[index..].find('>') {
                index += end + 1;
                continue;
            }
        }

        if is_url_start(&line[index..]) {
            while index < bytes.len()
                && !bytes[index].is_ascii_whitespace()
                && bytes[index] != b')'
                && bytes[index] != b'>'
            {
                index += 1;
            }
            continue;
        }

        if !bytes[index].is_ascii_alphabetic() {
            index += 1;
            continue;
        }

        let start = index;
        index += 1;
        while index < bytes.len() {
            if bytes[index].is_ascii_alphabetic() {
                index += 1;
                continue;
            }
            if bytes[index] == b'\''
                && index + 1 < bytes.len()
                && bytes[index + 1].is_ascii_alphabetic()
            {
                index += 1;
                continue;
            }
            break;
        }

        let word = &line[start..index];
        if word.len() <= 1 || word.chars().all(|character| character.is_ascii_uppercase()) {
            continue;
        }
        if dictionary.check(word) {
            continue;
        }

        let from = line_utf16_start + line[..start].encode_utf16().count();
        issues.push(SpellingIssue {
            from,
            to: from + word.encode_utf16().count(),
            word: word.to_string(),
        });
    }
}

#[tauri::command]
fn initialize_spellchecker(
    aff: String,
    dic: String,
    state: State<'_, SpellcheckState>,
) -> Result<(), String> {
    let dictionary = spellbook::Dictionary::new(&aff, &dic)
        .map_err(|err| format!("failed to load spelling dictionary: {err}"))?;
    let mut stored = state
        .dictionary
        .lock()
        .map_err(|err| format!("failed to lock spelling dictionary: {err}"))?;
    *stored = Some(dictionary);
    Ok(())
}

#[tauri::command]
fn spellcheck_document(
    content: String,
    state: State<'_, SpellcheckState>,
) -> Result<Vec<SpellingIssue>, String> {
    let stored = state
        .dictionary
        .lock()
        .map_err(|err| format!("failed to lock spelling dictionary: {err}"))?;
    let dictionary = stored
        .as_ref()
        .ok_or_else(|| "spelling dictionary is not initialized".to_string())?;

    let mut issues = Vec::new();
    let mut utf16_offset = 0;
    let mut fence: Option<char> = None;
    for line_with_ending in content.split_inclusive('\n') {
        let line = line_with_ending.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim_start();
        let fence_character = trimmed.chars().next().filter(|character| {
            (*character == '`' || *character == '~')
                && trimmed.chars().take_while(|candidate| candidate == character).count() >= 3
        });
        if let Some(character) = fence_character {
            match fence {
                Some(open) if open == character => fence = None,
                None => fence = Some(character),
                _ => {}
            }
        } else if fence.is_none() {
            check_spelling_line(line, utf16_offset, dictionary, &mut issues);
        }
        utf16_offset += line_with_ending.encode_utf16().count();
    }

    Ok(issues)
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
fn save_external_file(
    path: String,
    content: String,
    expected_fingerprint: Option<String>,
    force: bool,
) -> Result<SavedExternalFile, String> {
    let path = PathBuf::from(path);
    if path.exists() && !path.is_file() {
        return Err("path is not a file".to_string());
    }

    if !force {
        if let Some(expected) = expected_fingerprint {
            let current = std::fs::read(&path)
                .map_err(|err| format!("failed to verify file {}: {err}", path.display()))?;
            if content_fingerprint(&current) != expected {
                return Err("FILE_CHANGED_EXTERNALLY".to_string());
            }
        }
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create temporary file: {err}"))?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.as_file_mut().sync_all())
        .map_err(|err| format!("failed to write temporary file: {err}"))?;
    temporary
        .persist(&path)
        .map_err(|err| format!("failed to replace file {}: {}", path.display(), err.error))?;

    Ok(SavedExternalFile {
        fingerprint: content_fingerprint(content.as_bytes()),
    })
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

    let bytes = std::fs::read(&candidate).map_err(|err| format!("failed to read file: {err}"))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|err| format!("failed to decode file as UTF-8: {err}"))?;
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
        fingerprint: content_fingerprint(&bytes),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new().build();

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
        .plugin(global_shortcut)
        .setup(|app| {
            app.manage(LaunchPathState {
                path: Mutex::new(first_supported_path(&std::env::args().collect::<Vec<_>>())),
            });
            app.manage(SpellcheckState {
                dictionary: Mutex::new(None),
            });
            let _ = app.global_shortcut().on_shortcut(
                "Ctrl+Shift+Space",
                |app, _shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                },
            );
            Ok(())
        })
        .menu(|app| {
            let open = MenuItem::with_id(app, "file.open", "打开文件", true, Some("Ctrl+O"))?;
            let save = MenuItem::with_id(app, "file.save", "保存", true, Some("Ctrl+S"))?;
            let file_menu = Submenu::with_items(
                app,
                "文件",
                true,
                &[
                    &open,
                    &save,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("退出"))?,
                ],
            )?;

            let undo = MenuItem::with_id(app, "edit.undo", "撤销", true, Some("Ctrl+Z"))?;
            let redo = MenuItem::with_id(app, "edit.redo", "重做", true, Some("Ctrl+Y"))?;
            let find = MenuItem::with_id(app, "edit.find", "查找", true, Some("Ctrl+F"))?;
            let replace = MenuItem::with_id(app, "edit.replace", "查找和替换", true, Some("Ctrl+H"))?;
            let find_next = MenuItem::with_id(app, "edit.find_next", "下一个匹配", true, Some("F3"))?;
            let find_previous = MenuItem::with_id(
                app,
                "edit.find_previous",
                "上一个匹配",
                true,
                Some("Shift+F3"),
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("剪切"))?,
                    &PredefinedMenuItem::copy(app, Some("复制"))?,
                    &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                    &PredefinedMenuItem::select_all(app, Some("全选"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &find,
                    &replace,
                    &find_next,
                    &find_previous,
                ],
            )?;

            let editor = MenuItem::with_id(app, "view.editor", "单栏编辑", true, Some("Ctrl+1"))?;
            let preview = MenuItem::with_id(app, "view.preview", "单栏预览", true, Some("Ctrl+2"))?;
            let split = MenuItem::with_id(app, "view.split", "分栏", true, Some("Ctrl+3"))?;
            let view_menu = Submenu::with_items(
                app,
                "视图",
                true,
                &[&editor, &preview, &split],
            )?;

            Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().as_ref());
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_external_file,
            take_pending_launch_path,
            open_external_file,
            read_local_image,
            initialize_spellchecker,
            spellcheck_document
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
