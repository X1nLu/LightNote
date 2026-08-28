use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
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

const LANGUAGE_CONFIG_FILE: &str = "language-preference";

fn normalize_language(value: &str) -> Option<&'static str> {
    match value {
        "system" => Some("system"),
        "zh-CN" => Some("zh-CN"),
        "en" => Some("en"),
        _ => None,
    }
}

fn system_language() -> &'static str {
    sys_locale::get_locale()
        .as_deref()
        .map(|locale| locale.to_ascii_lowercase())
        .as_deref()
        .map(|locale| if locale.starts_with("zh") { "zh-CN" } else { "en" })
        .unwrap_or("en")
}

fn language_config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve language config directory: {error}"))?;
    Ok(directory.join(LANGUAGE_CONFIG_FILE))
}

fn read_language_preference<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &'static str {
    language_config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|value| normalize_language(value.trim()))
        .unwrap_or("system")
}

fn resolve_language<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &'static str {
    match read_language_preference(app) {
        "system" => system_language(),
        language => language,
    }
}

fn set_menu_item_text<R: tauri::Runtime>(item: Option<MenuItemKind<R>>, text: &str) {
    let Some(item) = item else {
        return;
    };
    match item {
        MenuItemKind::MenuItem(item) => {
            let _ = item.set_text(text);
        }
        MenuItemKind::Submenu(item) => {
            let _ = item.set_text(text);
        }
        MenuItemKind::Predefined(item) => {
            let _ = item.set_text(text);
        }
        MenuItemKind::Check(item) => {
            let _ = item.set_text(text);
        }
        MenuItemKind::Icon(item) => {
            let _ = item.set_text(text);
        }
    }
}

fn set_submenu_item_text_at<R: tauri::Runtime>(submenu: &Submenu<R>, index: usize, text: &str) {
    let item = submenu
        .items()
        .ok()
        .and_then(|items| items.into_iter().nth(index));
    set_menu_item_text(item, text);
}

fn update_menu_language<R: tauri::Runtime>(app: &tauri::AppHandle<R>, english: bool) {
    let Some(menu) = app.menu() else {
        return;
    };
    let items = menu.items().unwrap_or_default();
    let Some(MenuItemKind::Submenu(file_menu)) = items.first() else {
        return;
    };
    let Some(MenuItemKind::Submenu(edit_menu)) = items.get(1) else {
        return;
    };
    let Some(MenuItemKind::Submenu(view_menu)) = items.get(2) else {
        return;
    };

    set_menu_item_text(Some(MenuItemKind::Submenu(file_menu.clone())), if english { "File" } else { "文件" });
    set_menu_item_text(file_menu.get("file.open"), if english { "Open File" } else { "打开文件" });
    set_menu_item_text(file_menu.get("file.save"), if english { "Save" } else { "保存" });
    set_submenu_item_text_at(file_menu, 3, if english { "Quit" } else { "退出" });

    set_menu_item_text(Some(MenuItemKind::Submenu(edit_menu.clone())), if english { "Edit" } else { "编辑" });
    set_menu_item_text(edit_menu.get("edit.undo"), if english { "Undo" } else { "撤销" });
    set_menu_item_text(edit_menu.get("edit.redo"), if english { "Redo" } else { "重做" });
    set_submenu_item_text_at(edit_menu, 3, if english { "Cut" } else { "剪切" });
    set_submenu_item_text_at(edit_menu, 4, if english { "Copy" } else { "复制" });
    set_submenu_item_text_at(edit_menu, 5, if english { "Paste" } else { "粘贴" });
    set_submenu_item_text_at(edit_menu, 6, if english { "Select All" } else { "全选" });
    set_menu_item_text(edit_menu.get("edit.find"), if english { "Find" } else { "查找" });
    set_menu_item_text(edit_menu.get("edit.replace"), if english { "Find and Replace" } else { "查找和替换" });
    set_menu_item_text(edit_menu.get("edit.find_next"), if english { "Find Next" } else { "下一个匹配" });
    set_menu_item_text(edit_menu.get("edit.find_previous"), if english { "Find Previous" } else { "上一个匹配" });

    set_menu_item_text(Some(MenuItemKind::Submenu(view_menu.clone())), if english { "View" } else { "视图" });
    let view_items = view_menu.items().unwrap_or_default();
    let Some(MenuItemKind::Submenu(display_mode_menu)) = view_items.first() else {
        return;
    };
    let Some(MenuItemKind::Submenu(theme_menu)) = view_items.get(1) else {
        return;
    };
    let Some(MenuItemKind::Submenu(language_menu)) = view_items.get(2) else {
        return;
    };
    set_menu_item_text(Some(MenuItemKind::Submenu(display_mode_menu.clone())), if english { "Display Mode" } else { "显示模式" });
    set_menu_item_text(display_mode_menu.get("view.editor"), if english { "Editor" } else { "单栏编辑" });
    set_menu_item_text(display_mode_menu.get("view.preview"), if english { "Preview" } else { "单栏预览" });
    set_menu_item_text(display_mode_menu.get("view.split"), if english { "Split View" } else { "分栏" });
    set_menu_item_text(Some(MenuItemKind::Submenu(theme_menu.clone())), if english { "Theme" } else { "主题" });
    set_menu_item_text(theme_menu.get("view.theme.system"), if english { "System" } else { "跟随系统" });
    set_menu_item_text(theme_menu.get("view.theme.light"), if english { "Light" } else { "浅色" });
    set_menu_item_text(theme_menu.get("view.theme.dark"), if english { "Dark" } else { "深色" });
    set_menu_item_text(Some(MenuItemKind::Submenu(language_menu.clone())), if english { "Language" } else { "语言" });
    set_menu_item_text(language_menu.get("language.system"), if english { "Follow System" } else { "跟随系统" });
    set_menu_item_text(language_menu.get("language.zh-CN"), if english { "Simplified Chinese" } else { "中文简体" });
    set_menu_item_text(language_menu.get("language.en"), "English");
}

#[tauri::command]
fn get_language_preference<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    read_language_preference(&app).to_string()
}

#[tauri::command]
fn set_language_preference<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    language: String,
) -> Result<(), String> {
    let language = normalize_language(language.trim())
        .ok_or_else(|| "unsupported language preference".to_string())?;
    let path = language_config_path(&app)?;
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("failed to create language config directory: {error}"))?;
    }
    std::fs::write(path, language)
        .map_err(|error| format!("failed to save language preference: {error}"))
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
            if let Some(window) = app.get_webview_window("main") {
                let title = if resolve_language(&app.handle()) == "en" {
                    "LightNote"
                } else {
                    "LightNote"
                };
                let _ = window.set_title(title);
            }
            update_menu_language(&app.handle(), resolve_language(&app.handle()) == "en");
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
            let english = system_language() == "en";
            let open = MenuItem::with_id(
                app,
                "file.open",
                if english { "Open File" } else { "打开文件" },
                true,
                Some("Ctrl+O"),
            )?;
            let save = MenuItem::with_id(
                app,
                "file.save",
                if english { "Save" } else { "保存" },
                true,
                Some("Ctrl+S"),
            )?;
            let file_menu = Submenu::with_items(
                app,
                if english { "File" } else { "文件" },
                true,
                &[
                    &open,
                    &save,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(if english { "Quit" } else { "退出" }))?,
                ],
            )?;

            let undo = MenuItem::with_id(app, "edit.undo", if english { "Undo" } else { "撤销" }, true, Some("Ctrl+Z"))?;
            let redo = MenuItem::with_id(app, "edit.redo", if english { "Redo" } else { "重做" }, true, Some("Ctrl+Y"))?;
            let find = MenuItem::with_id(app, "edit.find", if english { "Find" } else { "查找" }, true, Some("Ctrl+F"))?;
            let replace = MenuItem::with_id(app, "edit.replace", if english { "Find and Replace" } else { "查找和替换" }, true, Some("Ctrl+H"))?;
            let find_next = MenuItem::with_id(app, "edit.find_next", if english { "Find Next" } else { "下一个匹配" }, true, Some("F3"))?;
            let find_previous = MenuItem::with_id(
                app,
                "edit.find_previous",
                if english { "Find Previous" } else { "上一个匹配" },
                true,
                Some("Shift+F3"),
            )?;
            let edit_menu = Submenu::with_items(
                app,
                if english { "Edit" } else { "编辑" },
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some(if english { "Cut" } else { "剪切" }))?,
                    &PredefinedMenuItem::copy(app, Some(if english { "Copy" } else { "复制" }))?,
                    &PredefinedMenuItem::paste(app, Some(if english { "Paste" } else { "粘贴" }))?,
                    &PredefinedMenuItem::select_all(app, Some(if english { "Select All" } else { "全选" }))?,
                    &PredefinedMenuItem::separator(app)?,
                    &find,
                    &replace,
                    &find_next,
                    &find_previous,
                ],
            )?;

            let editor = MenuItem::with_id(app, "view.editor", if english { "Editor" } else { "单栏编辑" }, true, Some("Ctrl+1"))?;
            let preview = MenuItem::with_id(app, "view.preview", if english { "Preview" } else { "单栏预览" }, true, Some("Ctrl+2"))?;
            let split = MenuItem::with_id(app, "view.split", if english { "Split View" } else { "分栏" }, true, Some("Ctrl+3"))?;
            let display_mode_menu = Submenu::with_items(
                app,
                if english { "Display Mode" } else { "显示模式" },
                true,
                &[&editor, &preview, &split],
            )?;
            let theme_system = MenuItem::with_id(app, "view.theme.system", if english { "System" } else { "跟随系统" }, true, None::<&str>)?;
            let theme_light = MenuItem::with_id(app, "view.theme.light", if english { "Light" } else { "浅色" }, true, None::<&str>)?;
            let theme_dark = MenuItem::with_id(app, "view.theme.dark", if english { "Dark" } else { "深色" }, true, None::<&str>)?;
            let theme_menu = Submenu::with_items(
                app,
                if english { "Theme" } else { "主题" },
                true,
                &[&theme_system, &theme_light, &theme_dark],
            )?;
            let language_system = MenuItem::with_id(app, "language.system", if english { "Follow System" } else { "跟随系统" }, true, None::<&str>)?;
            let language_zh = MenuItem::with_id(app, "language.zh-CN", if english { "Simplified Chinese" } else { "中文简体" }, true, None::<&str>)?;
            let language_en = MenuItem::with_id(app, "language.en", "English", true, None::<&str>)?;
            let language_menu = Submenu::with_items(
                app,
                if english { "Language" } else { "语言" },
                true,
                &[&language_system, &language_zh, &language_en],
            )?;
            let view_menu = Submenu::with_items(
                app,
                if english { "View" } else { "视图" },
                true,
                &[
                    &display_mode_menu,
                    &theme_menu,
                    &language_menu,
                ],
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
            spellcheck_document,
            get_language_preference,
            set_language_preference
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
