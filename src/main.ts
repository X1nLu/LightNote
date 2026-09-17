import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import DOMPurify from "dompurify";
import { basicSetup } from "codemirror";
import { redo, undo } from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
} from "@codemirror/search";
import { Decoration, DecorationSet, EditorView, keymap } from "@codemirror/view";
import { TabManager, type TabState } from "./tabs";
import "katex/dist/katex.min.css";

const appShellEl = document.querySelector(".app-shell") as HTMLElement;
const workspaceEl = document.querySelector(".workspace") as HTMLElement;
const statusEl = document.querySelector("#save-status") as HTMLSpanElement;
const editorRootEl = document.querySelector("#editor") as HTMLDivElement;
const previewEl = document.querySelector("#preview") as HTMLDivElement;
const splitDividerEl = document.querySelector("#split-divider") as HTMLDivElement;
const tabBarEl = document.querySelector("#tab-bar") as HTMLElement;
const tabNewButtonEl = document.querySelector("#tab-new") as HTMLButtonElement;

type LanguagePreference = "system" | "zh-CN" | "en";
type AppLanguage = Exclude<LanguagePreference, "system">;

const translations: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": {
    languageLabel: "语言",
    languageSystem: "跟随系统",
    languageChinese: "中文简体",
    languageEnglish: "English",
    editor: "编辑",
    preview: "预览",
    resize: "调整编辑区与预览区宽度",
    ready: "准备就绪",
    spellingError: "可能的拼写错误: {word}",
    spellcheckFailed: "拼写检查失败: {error}",
    spellcheckInitFailed: "拼写检查初始化失败: {error}",
    autosaved: "已自动保存: {path}",
    saved: "已保存文件: {path}",
    conflictPaused: "文件已被其他程序修改，已暂停自动保存",
    saveFailed: "{operation}失败: {error}",
    autoSave: "自动保存",
    fileSave: "文件保存",
    noFile: "未选择文件",
    openFailed: "打开文件失败: {error}",
    noSavePath: "未选择保存位置",
    conflict: "文件已被其他程序修改。是否用当前编辑内容覆盖磁盘文件？",
    conflictTitle: "文件冲突",
    cancelSave: "已取消保存，磁盘文件未被覆盖",
    fileSaveFailed: "文件保存失败: {error}",
    closeDirtyTitle: "关闭未保存的标签",
    closeDirtyMessage: "“{title}”有未保存的修改，确定丢弃并关闭？",
    readOnlyOpened: "已只读打开: {path}（源文件为只读）",
    opened: "已打开: {path}",
    launchFailed: "处理启动文件失败: {error}",
    contextOpenFailed: "打开右键文件失败: {error}",
    unsaved: "有未保存修改",
    newDocument: "新建文档，尚未保存到文件",
    initialText: "# LightNote\n\n欢迎使用，一个轻量、离线优先的 Markdown 编辑器。\n\n- 支持打开和保存 Markdown 文件\n- 支持 KaTeX 公式\n- 支持 Mermaid 流程图\n\n行内公式：$E = mc^2$\n\n块公式：\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n```mermaid\nflowchart TD\n  A[Start] --> B{Need Review?}\n  B -- Yes --> C[Edit Markdown]\n  B -- No --> D[Done]\n```\n",
  },
  en: {
    languageLabel: "Language",
    languageSystem: "Follow system",
    languageChinese: "Simplified Chinese",
    languageEnglish: "English",
    editor: "Editor",
    preview: "Preview",
    resize: "Resize the editor and preview panels",
    ready: "Ready",
    spellingError: "Possible spelling error: {word}",
    spellcheckFailed: "Spellcheck failed: {error}",
    spellcheckInitFailed: "Spellcheck initialization failed: {error}",
    autosaved: "Automatically saved: {path}",
    saved: "Saved file: {path}",
    conflictPaused: "The file was changed by another program. Autosave is paused.",
    saveFailed: "{operation} failed: {error}",
    autoSave: "Autosave",
    fileSave: "File save",
    noFile: "No file selected",
    openFailed: "Failed to open file: {error}",
    noSavePath: "No save location selected",
    conflict: "The file was changed by another program. Overwrite it with the current editor content?",
    conflictTitle: "File conflict",
    cancelSave: "Save cancelled. The disk file was not overwritten.",
    fileSaveFailed: "Failed to save file: {error}",
    closeDirtyTitle: "Close unsaved tab",
    closeDirtyMessage: "“{title}” has unsaved changes. Discard and close?",
    readOnlyOpened: "Opened read-only: {path} (the source file is read-only)",
    opened: "Opened: {path}",
    launchFailed: "Failed to process startup file: {error}",
    contextOpenFailed: "Failed to open context-menu file: {error}",
    unsaved: "Unsaved changes",
    newDocument: "New document, not saved to a file",
    initialText: "# LightNote\n\nWelcome to LightNote, a lightweight, offline-first Markdown editor.\n\n- Open and save Markdown files\n- KaTeX formulas\n- Mermaid diagrams\n\nInline formula: $E = mc^2$\n\nBlock formula:\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n```mermaid\nflowchart TD\n  A[Start] --> B{Need Review?}\n  B -- Yes --> C[Edit Markdown]\n  B -- No --> D[Done]\n```\n",
  },
};

let currentLanguage: AppLanguage = "zh-CN";

function resolveLanguage(preference: LanguagePreference): AppLanguage {
  return preference === "system"
    ? navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
    : preference;
}

function translate(key: string, values: Record<string, string> = {}): string {
  let message = translations[currentLanguage][key] ?? key;
  for (const [name, value] of Object.entries(values)) {
    message = message.split(`{${name}}`).join(value);
  }
  return message;
}

function applyLanguage(preference: LanguagePreference): void {
  currentLanguage = resolveLanguage(preference);
  document.documentElement.lang = currentLanguage;
  // 若有激活标签，其标题（含 dirty 标记）优先，避免丢失标签信息。
  const active = tabManager.getActive();
  document.title = active ? active.title : currentLanguage === "en" ? "LightNote" : "LightNote";
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    if (element === statusEl) {
      return;
    }
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = translate(key);
    }
  });
  const divider = document.querySelector<HTMLElement>("#split-divider");
  divider?.setAttribute("aria-label", translate("resize"));
}

async function initializeLanguage(): Promise<void> {
  try {
    const preference = await invoke<string>("get_language_preference");
    if (preference === "system" || preference === "zh-CN" || preference === "en") {
      applyLanguage(preference);
      return;
    }
  } catch {
    // Keep the Chinese fallback when the language preference cannot be read.
  }
  applyLanguage("system");
}

async function saveLanguagePreference(preference: LanguagePreference): Promise<void> {
  try {
    await invoke("set_language_preference", { language: preference });
    applyLanguage(preference);
  } catch (error) {
    setStatus(String(error));
  }
}

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).use(markdownItKatex as never);

const rawFenceRenderer = markdownRenderer.renderer.rules.fence;

function getSourceRangeAttributes(token: any): string {
  if (!Array.isArray(token.map) || token.map.length < 2) {
    return "";
  }

  return ` data-source-start="${token.map[0] + 1}" data-source-end="${token.map[1]}"`;
}

function addSourceRangeToTag(html: string, tagName: string, token: any): string {
  const attributes = getSourceRangeAttributes(token);
  return attributes ? html.replace(`<${tagName}`, `<${tagName}${attributes}`) : html;
}

markdownRenderer.renderer.rules.fence = (
  tokens: any[],
  idx: number,
  options: any,
  env: any,
  self: any,
) => {
  const token = tokens[idx];
  const info = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (info === "mermaid") {
    return `<div class="mermaid"${getSourceRangeAttributes(token)}>${escapeHtml(normalizeMermaidSource(token.content))}</div>`;
  }
  const rendered = rawFenceRenderer
    ? rawFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return addSourceRangeToTag(rendered, "pre", token);
};

let mermaidLib: typeof import("mermaid") | null = null;
type DisplayMode = "editor" | "preview" | "split";
const editableCompartment = new Compartment();
const themeCompartment = new Compartment();
const SPLIT_RATIO_STORAGE_KEY = "lightnote.split-pane-ratio";
const DOCUMENT_BASE_DIR_STORAGE_KEY = "lightnote.document-base-dir";
const THEME_STORAGE_KEY = "lightnote.theme";
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_PANEL_WIDTH = 280;
const SPLIT_DIVIDER_WIDTH = 10;
const AUTO_SAVE_DELAY_MS = 1000;
const EXTERNAL_CHANGE_ERROR = "FILE_CHANGED_EXTERNALLY";
const SPELLCHECK_DELAY_MS = 450;
type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = Exclude<ThemePreference, "system">;

let themePreference = loadThemePreference();
let resolvedTheme: ResolvedTheme = resolveTheme(themePreference);

function loadThemePreference(): ThemePreference {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : preference;
}

function persistThemePreference(): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  } catch {
    return;
  }
}

function getEditorTheme(): ReturnType<typeof EditorView.theme> {
  const dark = resolvedTheme === "dark";
  return EditorView.theme(
    {
      "&": { color: dark ? "#d8d6ce" : "#2a241d", backgroundColor: dark ? "#20211f" : "#fefcf8" },
      ".cm-content": { caretColor: dark ? "#a8c7b9" : "#0f766e" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: dark ? "#a8c7b9" : "#0f766e" },
      ".cm-gutters": { color: dark ? "#8e9189" : "#7a746b", backgroundColor: dark ? "#1c1d1b" : "#f8f7f2", border: "none" },
      ".cm-activeLine": { backgroundColor: dark ? "#292b28" : "#faf8f1" },
      ".cm-activeLineGutter": { backgroundColor: dark ? "#292b28" : "#f0eee6" },
      ".cm-searchMatch": { backgroundColor: dark ? "#625b38" : "#f4df9f" },
      ".cm-searchMatch-selected": { backgroundColor: dark ? "#8b7b3e" : "#e7c55b" },
    },
    { dark },
  );
}

function configureMermaidTheme(): void {
  mermaidLib?.default.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: resolvedTheme === "dark" ? "dark" : "neutral",
  });
}

function applyTheme(preference: ThemePreference, persist = true): void {
  themePreference = preference;
  resolvedTheme = resolveTheme(preference);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
  if (persist) {
    persistThemePreference();
  }
  if (editorView) {
    editorView.dispatch({ effects: themeCompartment.reconfigure(getEditorTheme()) });
  }
  configureMermaidTheme();
  if (editorView && !appShellEl.classList.contains("mode-editor")) {
    void renderPreview(getEditorContent());
  }
}

const documentSearchKeymap = keymap.of([
  { key: "Mod-f", run: openSearchPanel },
  { key: "Mod-h", run: openSearchPanel },
  { key: "F3", run: findNext },
  { key: "Shift-F3", run: findPrevious },
  { key: "Escape", run: closeSearchPanel },
]);

interface SpellingIssue {
  from: number;
  to: number;
  word: string;
}

const setSpellingIssues = StateEffect.define<SpellingIssue[]>();
const spellingIssueField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSpellingIssues)) {
        continue;
      }
      const ranges = effect.value
        .filter(({ from, to }) => from >= 0 && to > from && to <= transaction.state.doc.length)
        .map(({ from, to, word }) =>
          Decoration.mark({
            class: "cm-spelling-error",
            attributes: { title: translate("spellingError", { word }) },
          }).range(from, to),
        );
      decorations = Decoration.set(ranges, true);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface OpenedExternalFile {
  path: string;
  content: string;
  readOnly: boolean;
  baseDir: string;
  fingerprint: string;
}

interface SavedExternalFile {
  fingerprint: string;
}

interface LocalImage {
  data: string;
  mimeType: string;
}

async function getMermaid() {
  if (mermaidLib) {
    return mermaidLib;
  }
  const lib = await import("mermaid");
  lib.default.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: resolvedTheme === "dark" ? "dark" : "neutral",
  });
  mermaidLib = lib;
  return lib;
}

let editorView: EditorView;
let mermaidRenderId = 0;
let previewRenderId = 0;
let saveQueue: Promise<void> = Promise.resolve();
let spellcheckReady = false;
let spellcheckTimer: number | null = null;
let spellcheckRequestId = 0;
let previewObjectUrls: string[] = [];
let splitRatio = loadSplitRatio();
let activeSplitPointerId: number | null = null;
let editorScrollAnimationFrame: number | null = null;
/** 程序化载入文档（切标签/打开文件）时置位，抑制 docChanged 的 dirty/autosave 副作用。 */
let suppressDocChanged = false;

/** 标签管理器：每个文档一个 TabState，始终有一个激活标签。 */
const tabManager = new TabManager();

/** 返回当前激活标签（多标签模型下该值始终存在）。 */
function getActiveTab(): TabState {
  return tabManager.getActive() as TabState;
}

/** 当前语言下的「未命名」默认标签标题。 */
function untitledTitle(): string {
  return currentLanguage === "zh-CN" ? "未命名" : "Untitled";
}

/** 从文件路径提取标签标题（basename）。 */
function titleFromPath(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() || untitledTitle();
}

/** 根据激活标签更新窗口标题。 */
function updateWindowTitle(tab: TabState): void {
  const base = currentLanguage === "en" ? "LightNote" : "LightNote";
  const dirty = tab.dirty ? " •" : "";
  document.title = `${tab.title}${dirty} - ${base}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function loadSplitRatio(): number {
  try {
    const storedRatio = Number.parseFloat(
      window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY) ?? "",
    );
    return Number.isFinite(storedRatio)
      ? clamp(storedRatio, 0.1, 0.9)
      : DEFAULT_SPLIT_RATIO;
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

function persistSplitRatio(): void {
  try {
    window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitRatio));
  } catch {
    return;
  }
}

function persistDocumentBaseDir(baseDir: string | null): void {
  try {
    if (baseDir) {
      window.localStorage.setItem(DOCUMENT_BASE_DIR_STORAGE_KEY, baseDir);
    } else {
      window.localStorage.removeItem(DOCUMENT_BASE_DIR_STORAGE_KEY);
    }
  } catch {
    return;
  }
}

function isSplitMode(): boolean {
  return appShellEl.classList.contains("mode-split");
}

function getSplitMetrics(): {
  availableWidth: number;
  minimumRatio: number;
  maximumRatio: number;
} | null {
  const workspaceWidth = workspaceEl.getBoundingClientRect().width;
  const dividerWidth =
    splitDividerEl.getBoundingClientRect().width || SPLIT_DIVIDER_WIDTH;
  const availableWidth = workspaceWidth - dividerWidth;
  if (availableWidth <= 0) {
    return null;
  }

  const minimumRatio = MIN_SPLIT_PANEL_WIDTH / availableWidth;
  return {
    availableWidth,
    minimumRatio,
    maximumRatio: 1 - minimumRatio,
  };
}

function applySplitRatio(): void {
  if (!isSplitMode() || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  const metrics = getSplitMetrics();
  if (!metrics || metrics.minimumRatio > metrics.maximumRatio) {
    return;
  }

  splitRatio = clamp(splitRatio, metrics.minimumRatio, metrics.maximumRatio);
  const editorWidth = metrics.availableWidth * splitRatio;
  workspaceEl.style.setProperty("--editor-pane-width", `${editorWidth}px`);
  splitDividerEl.setAttribute("aria-valuemin", String(MIN_SPLIT_PANEL_WIDTH));
  splitDividerEl.setAttribute(
    "aria-valuemax",
    String(Math.floor(metrics.availableWidth - MIN_SPLIT_PANEL_WIDTH)),
  );
  splitDividerEl.setAttribute("aria-valuenow", String(Math.round(editorWidth)));
}

function updateSplitRatioFromPointer(clientX: number): void {
  const metrics = getSplitMetrics();
  if (!metrics) {
    return;
  }

  const workspaceRect = workspaceEl.getBoundingClientRect();
  const dividerWidth =
    splitDividerEl.getBoundingClientRect().width || SPLIT_DIVIDER_WIDTH;
  const editorWidth = clientX - workspaceRect.left - dividerWidth / 2;
  splitRatio = clamp(
    editorWidth / metrics.availableWidth,
    metrics.minimumRatio,
    metrics.maximumRatio,
  );
  applySplitRatio();
}

function handleSplitPointerDown(event: PointerEvent): void {
  if (!isSplitMode() || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  event.preventDefault();
  activeSplitPointerId = event.pointerId;
  document.body.classList.add("is-resizing-split");
  updateSplitRatioFromPointer(event.clientX);
}

function handleSplitPointerMove(event: PointerEvent): void {
  if (event.pointerId !== activeSplitPointerId) {
    return;
  }

  event.preventDefault();
  updateSplitRatioFromPointer(event.clientX);
}

function handleSplitPointerEnd(event: PointerEvent): void {
  if (event.pointerId !== activeSplitPointerId) {
    return;
  }

  activeSplitPointerId = null;
  document.body.classList.remove("is-resizing-split");
  persistSplitRatio();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function normalizeMermaidSource(source: string): string {
  return source.replace(/[\u00a0\u202f]/g, " ");
}

function normalizeMarkdownFences(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const normalizedLines: string[] = [];
  let openingFence: { character: string; length: number } | null = null;

  for (const line of lines) {
    const openingMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!openingFence && openingMatch) {
      openingFence = {
        character: openingMatch[1][0],
        length: openingMatch[1].length,
      };
      normalizedLines.push(line);
      continue;
    }

    if (!openingFence) {
      normalizedLines.push(line);
      continue;
    }

    const closingMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (
      closingMatch &&
      closingMatch[1][0] === openingFence.character &&
      closingMatch[1].length >= openingFence.length
    ) {
      normalizedLines.push(line);
      openingFence = null;
      continue;
    }

    const appendedClosingMatch = line.match(/^(.*?)(`{3,}|~{3,})\s*$/);
    if (
      appendedClosingMatch &&
      appendedClosingMatch[2][0] === openingFence.character &&
      appendedClosingMatch[2].length >= openingFence.length
    ) {
      normalizedLines.push(appendedClosingMatch[1].trimEnd());
      normalizedLines.push(appendedClosingMatch[2]);
      openingFence = null;
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

function setDisplayMode(mode: DisplayMode): void {
  appShellEl.classList.remove("mode-editor", "mode-preview", "mode-split");
  appShellEl.classList.add(`mode-${mode}`);

  applySplitRatio();

  if (mode !== "editor" && editorView) {
    void renderPreview(getEditorContent()).then(() => {
      syncPreviewToEditor(editorView);
    });
  }
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setDirtyState(dirty: boolean): void {
  const active = tabManager.getActive();
  if (!active) {
    return;
  }
  const changed = active.dirty !== dirty;
  tabManager.updateTab(active.id, { dirty });
  if (changed) {
    updateWindowTitle(active);
  }
}

function cancelPendingAutoSave(tab?: TabState): void {
  const target = tab ?? tabManager.getActive();
  if (!target || target.autoSaveTimer === null) {
    return;
  }
  window.clearTimeout(target.autoSaveTimer);
  tabManager.updateTab(target.id, { autoSaveTimer: null });
}

function queueAutoSave(): void {
  const active = tabManager.getActive();
  if (!active) {
    return;
  }
  cancelPendingAutoSave(active);
  if (active.path === null || active.readOnly || active.conflictPaused) {
    return;
  }

  tabManager.updateTab(active.id, {
    autoSaveTimer: window.setTimeout(() => {
      const stillActive = tabManager.getActive();
      if (stillActive?.id === active.id) {
        tabManager.updateTab(active.id, { autoSaveTimer: null });
        void saveCurrentDocument(active, true);
      } else {
        // 切走后的定时器不再由该标签持有，直接清掉，避免误存。
        tabManager.updateTab(active.id, { autoSaveTimer: null });
      }
    }, AUTO_SAVE_DELAY_MS),
  });
}

function queueSpellcheck(): void {
  if (!spellcheckReady) {
    return;
  }
  if (spellcheckTimer !== null) {
    window.clearTimeout(spellcheckTimer);
  }
  spellcheckTimer = window.setTimeout(() => {
    spellcheckTimer = null;
    void checkCurrentDocumentSpelling();
  }, SPELLCHECK_DELAY_MS);
}

async function checkCurrentDocumentSpelling(): Promise<void> {
  const requestId = ++spellcheckRequestId;
  const content = getEditorContent();
  try {
    const issues = await invoke<SpellingIssue[]>("spellcheck_document", { content });
    if (requestId !== spellcheckRequestId || getEditorContent() !== content) {
      return;
    }
    editorView.dispatch({ effects: setSpellingIssues.of(issues) });
  } catch (error) {
    setStatus(translate("spellcheckFailed", { error: String(error) }));
  }
}

async function initializeSpellchecker(): Promise<void> {
  try {
    const [aff, dic] = await Promise.all([
      import("../node_modules/dictionary-en/index.aff?raw"),
      import("../node_modules/dictionary-en/index.dic?raw"),
    ]);
    await invoke("initialize_spellchecker", {
      aff: aff.default,
      dic: dic.default,
    });
    spellcheckReady = true;
    queueSpellcheck();
  } catch (error) {
    setStatus(translate("spellcheckInitFailed", { error: String(error) }));
  }
}

function writeDocument(
  path: string,
  content: string,
  expectedFingerprint: string | null,
  force: boolean,
): Promise<SavedExternalFile> {
  let result: SavedExternalFile | undefined;
  const operation = saveQueue.catch(() => undefined).then(async () => {
    result = await invoke<SavedExternalFile>("save_external_file", {
      path,
      content,
      expectedFingerprint,
      force,
    });
  });
  saveQueue = operation;
  return operation.then(() => result as SavedExternalFile);
}

async function saveCurrentDocument(tab: TabState, autoSave: boolean): Promise<void> {
  const path = tab.path;
  if (!path || tab.readOnly) {
    return;
  }

  const isActive = tabManager.getActive()?.id === tab.id;
  const content = isActive ? getEditorContent() : tab.content;
  const expectedFingerprint = tab.fingerprint;
  try {
    const saved = await writeDocument(path, content, expectedFingerprint, false);
    if (tabManager.getActive()?.id !== tab.id) {
      return;
    }
    tabManager.updateTab(tab.id, { fingerprint: saved.fingerprint });
    const currentContent = getEditorContent();
    if (currentContent === content) {
      setDirtyState(false);
      setStatus(translate(autoSave ? "autosaved" : "saved", { path }));
    } else {
      queueAutoSave();
    }
  } catch (error) {
    if (String(error).includes(EXTERNAL_CHANGE_ERROR)) {
      tabManager.updateTab(tab.id, { conflictPaused: true });
      setStatus(translate("conflictPaused"));
      return;
    }
    setStatus(translate("saveFailed", {
      operation: translate(autoSave ? "autoSave" : "fileSave"),
      error: String(error),
    }));
  }
}

function setEditorReadOnly(readOnly: boolean): void {
  editorView.dispatch({
    effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
  });
}

async function renderMermaidNodes(container: HTMLElement, renderId: number): Promise<void> {
  const nodes = Array.from(container.querySelectorAll(".mermaid")) as HTMLElement[];
  if (nodes.length === 0) {
    return;
  }
  try {
    const mermaid = await getMermaid();
    for (const node of nodes) {
      if (renderId !== previewRenderId) {
        return;
      }
      const source = node.textContent ?? "";
      const id = `mermaid-diagram-${++mermaidRenderId}`;
      try {
        const rendered = await mermaid.default.render(id, source);
        if (renderId !== previewRenderId) {
          return;
        }
        node.innerHTML = rendered.svg;
        rendered.bindFunctions?.(node);
      } catch {
        node.classList.add("mermaid-error");
      }
    }
  } catch {
    // Mermaid 语法错误保留原文本即可，不阻塞编辑。
  }
}

function getEditorContent(): string {
  return editorView.state.doc.toString();
}

function revokePreviewObjectUrls(): void {
  for (const objectUrl of previewObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  previewObjectUrls = [];
}

function decodeBase64ToBlob(data: string, mimeType: string): Blob {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function getLocalImagePath(source: string): string | null {
  const trimmedSource = source.trim();
  if (
    !trimmedSource ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmedSource)
  ) {
    return null;
  }

  const pathWithoutQuery = trimmedSource.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(pathWithoutQuery);
  } catch {
    return pathWithoutQuery;
  }
}

async function loadLocalImages(
  container: HTMLElement,
  baseDir: string | null,
  renderId: number,
): Promise<void> {
  if (!baseDir) {
    return;
  }

  const images = Array.from(container.querySelectorAll("img")) as HTMLImageElement[];
  await Promise.all(
    images.map(async (image) => {
      const source = image.getAttribute("src");
      if (source) {
        image.dataset.originalSrc = source;
      }
      const imagePath = source ? getLocalImagePath(source) : null;
      if (!imagePath) {
        return;
      }

      try {
        const localImage = await invoke<LocalImage>("read_local_image", {
          baseDir,
          imagePath,
        });
        if (renderId !== previewRenderId) {
          return;
        }
        const objectUrl = URL.createObjectURL(
          decodeBase64ToBlob(localImage.data, localImage.mimeType),
        );
        previewObjectUrls.push(objectUrl);
        image.src = objectUrl;
        image.classList.remove("image-load-error");
      } catch {
        image.classList.add("image-load-error");
        return;
      }
    }),
  );
}

function renderMarkdownWithSourceRanges(content: string): string {
  const tokens = markdownRenderer.parse(normalizeMarkdownFences(content), {});
  for (const token of tokens) {
    if (!Array.isArray(token.map) || token.map.length < 2 || token.nesting === -1) {
      continue;
    }
    token.attrSet("data-source-start", String(token.map[0] + 1));
    token.attrSet("data-source-end", String(token.map[1]));
  }
  return markdownRenderer.renderer.render(
    tokens,
    markdownRenderer.options,
    {},
  );
}

function getPreviewBlockForLine(lineNumber: number): HTMLElement | null {
  const blocks = Array.from(
    previewEl.querySelectorAll<HTMLElement>(
      "[data-source-start][data-source-end]",
    ),
  )
    .map((element) => ({
      element,
      start: Number.parseInt(element.dataset.sourceStart ?? "", 10),
      end: Number.parseInt(element.dataset.sourceEnd ?? "", 10),
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end));

  let containingBlock: (typeof blocks)[number] | null = null;
  for (const block of blocks) {
    if (lineNumber < block.start || lineNumber > block.end) {
      continue;
    }
    if (
      !containingBlock ||
      block.end - block.start <= containingBlock.end - containingBlock.start
    ) {
      containingBlock = block;
    }
  }
  if (containingBlock) {
    return containingBlock.element;
  }

  const nextBlock = blocks.find(({ start }) => start > lineNumber);
  return nextBlock?.element ?? blocks[blocks.length - 1]?.element ?? null;
}

function getEditorTopVisibleLine(view: EditorView): number {
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const position = view.posAtCoords(
    {
      x: Math.max(contentRect.left + 1, scrollerRect.left + 1),
      y: scrollerRect.top + 1,
    },
    false,
  );

  return view.state.doc.lineAt(position ?? view.viewport.from).number;
}

function syncPreviewToEditor(view: EditorView, lineNumber?: number): void {
  if (!isSplitMode()) {
    return;
  }

  const block = getPreviewBlockForLine(
    lineNumber ?? view.state.doc.lineAt(view.state.selection.main.head).number,
  );
  if (!block) {
    return;
  }

  const previewRect = previewEl.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const topOffset = previewEl.clientHeight * 0.35;
  const targetTop =
    previewEl.scrollTop + blockRect.top - previewRect.top - topOffset;
  const maxScrollTop = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight);
  previewEl.scrollTop = clamp(targetTop, 0, maxScrollTop);
}

function schedulePreviewSyncToEditorScroll(): void {
  if (!isSplitMode() || editorScrollAnimationFrame !== null) {
    return;
  }

  editorScrollAnimationFrame = window.requestAnimationFrame(() => {
    editorScrollAnimationFrame = null;
    syncPreviewToEditor(editorView, getEditorTopVisibleLine(editorView));
  });
}

function getSourceLineFromPreviewTarget(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const block = target.closest<HTMLElement>(
    "[data-source-start][data-source-end]",
  );
  if (!block || target.closest("a, button, input, textarea, select, option")) {
    return null;
  }

  const lineNumber = Number.parseInt(block.dataset.sourceStart ?? "", 10);
  return Number.isFinite(lineNumber) ? lineNumber : null;
}

function focusEditorLine(lineNumber: number): void {
  if (!editorView) {
    return;
  }

  const line = editorView.state.doc.line(
    clamp(lineNumber, 1, editorView.state.doc.lines),
  );
  editorView.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  editorView.focus();
}

async function handlePreviewClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a") : null;
  const href = link?.getAttribute("href")?.trim();
  if (link && !href?.startsWith("#")) {
    event.preventDefault();
    if (!href) {
      return;
    }
    try {
      const url = new URL(href);
      if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
        await openUrl(url.toString());
      }
    } catch {
      // Relative and malformed links must not navigate the application webview.
    }
    return;
  }

  if (!isSplitMode()) {
    return;
  }

  const lineNumber = getSourceLineFromPreviewTarget(event.target);
  if (lineNumber === null) {
    return;
  }

  focusEditorLine(lineNumber);
}

async function renderPreview(content: string): Promise<void> {
  const renderId = ++previewRenderId;
  revokePreviewObjectUrls();
  const html = renderMarkdownWithSourceRanges(content);
  const sanitizedHtml = DOMPurify.sanitize(html);
  previewEl.innerHTML = sanitizedHtml;
  await loadLocalImages(previewEl, getActiveTab().baseDir, renderId);
  if (renderId !== previewRenderId) {
    return;
  }
  await renderMermaidNodes(previewEl, renderId);
}

function replaceEditorText(content: string): void {
  // dispatch 是同步的：置位后再 dispatch，监听器在同步执行期间能看到该标志，
  // 从而不把程序化载入当作「用户编辑」而标脏/触发自动保存。
  suppressDocChanged = true;
  editorView.dispatch({
    changes: {
      from: 0,
      to: editorView.state.doc.length,
      insert: content,
    },
  });
  suppressDocChanged = false;
}

async function handleImportMarkdown(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown", "txt"],
        },
      ],
    });

    if (!selected || Array.isArray(selected)) {
      setStatus(translate("noFile"));
      return;
    }

    const opened = await invoke<OpenedExternalFile>("open_external_file", {
      path: selected,
    });
    await openDocumentInTab(opened);
  } catch (error) {
    setStatus(translate("openFailed", { error: String(error) }));
  }
}

async function handleSaveFile(): Promise<void> {
  const tab = getActiveTab();
  try {
    cancelPendingAutoSave(tab);
    let path = tab.path;
    let expectedFingerprint = tab.fingerprint;
    if (!path || tab.readOnly) {
      path = await save({
        defaultPath: path ?? "note.md",
        filters: [
          {
            name: "Markdown",
            extensions: ["md", "markdown", "txt"],
          },
        ],
      });
      if (!path) {
        setStatus(translate("noSavePath"));
        return;
      }
      expectedFingerprint = null;
    }

    const content = getEditorContent();
    let saved: SavedExternalFile;
    try {
      saved = await writeDocument(path, content, expectedFingerprint, false);
    } catch (error) {
      if (!String(error).includes(EXTERNAL_CHANGE_ERROR)) {
        throw error;
      }
      const overwrite = await confirm(
        translate("conflict"),
        { title: translate("conflictTitle"), kind: "warning" },
      );
      if (!overwrite) {
        setStatus(translate("cancelSave"));
        return;
      }
      saved = await writeDocument(path, content, null, true);
    }
    tabManager.updateTab(tab.id, {
      path,
      readOnly: false,
      fingerprint: saved.fingerprint,
      conflictPaused: false,
      title: titleFromPath(path),
    });
    setDirtyState(false);
    setEditorReadOnly(false);
    setStatus(translate("saved", { path }));
  } catch (error) {
    setStatus(translate("fileSaveFailed", { error: String(error) }));
  }
}

/** 把「激活标签」的文档载入编辑器视图（切标签、刚打开文件时通用）。 */
function loadActiveTabIntoEditor(): void {
  const tab = getActiveTab();
  // 取消该标签上一次编辑可能遗留的待定自动保存。
  cancelPendingAutoSave(tab);
  // replaceEditorText 为程序化载入：由 suppressDocChanged 抑制 dirty/autosave 副作用，
  // 预览渲染已由其 docChanged 触发，这里不重复渲染。
  replaceEditorText(tab.content);
  setEditorReadOnly(tab.readOnly);
  setDirtyState(tab.dirty);
  queueSpellcheck();
}

/** 打开外部文件：自动去重——已存在同路径标签则激活之，否则新建标签并载入。 */
async function openDocumentInTab(opened: OpenedExternalFile): Promise<TabState> {
  persistDocumentBaseDir(opened.baseDir);
  // openPath 可能把活动标签切换走（去重激活已有标签，或新建标签），
  // 先快照当前标签的未保存内容，避免丢失。
  const current = tabManager.getActive();
  if (current) {
    snapshotCurrentEditor(current);
  }
  const tab = tabManager.openPath({
    title: titleFromPath(opened.path),
    path: opened.path,
    baseDir: opened.baseDir,
    readOnly: opened.readOnly,
    fingerprint: opened.fingerprint,
    content: opened.content,
  });
  loadActiveTabIntoEditor();
  if (opened.readOnly) {
    setStatus(translate("readOnlyOpened", { path: opened.path }));
  } else {
    setStatus(translate("opened", { path: opened.path }));
  }
  return tab;
}

/** 重建标签栏里的标签元素（保留静态的「新建」按钮）。 */
function renderTabBar(): void {
  if (!tabBarEl) {
    return;
  }
  tabBarEl.querySelectorAll(".tab").forEach((element) => element.remove());
  const activeId = tabManager.getActive()?.id ?? -1;
  const newButton = tabBarEl.querySelector<HTMLElement>("#tab-new");
  const fragment = document.createDocumentFragment();
  for (const tab of tabManager.getAll()) {
    const tabEl = document.createElement("button");
    tabEl.type = "button";
    tabEl.className = "tab" + (tab.id === activeId ? " active" : "");
    tabEl.dataset.tabId = String(tab.id);
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("aria-selected", tab.id === activeId ? "true" : "false");

    const titleEl = document.createElement("span");
    titleEl.className = "tab-title";
    titleEl.textContent = tab.title;
    tabEl.appendChild(titleEl);

    const closeEl = document.createElement("span");
    closeEl.className = "tab-close";
    closeEl.textContent = "×";
    closeEl.dataset.closeFor = String(tab.id);
    closeEl.setAttribute("aria-label", "关闭");
    tabEl.appendChild(closeEl);

    fragment.appendChild(tabEl);
  }
  if (newButton) {
    tabBarEl.insertBefore(fragment, newButton);
  } else {
    tabBarEl.appendChild(fragment);
  }
}

/** 把当前激活标签的编辑器文本/光标快照写回其 TabState。 */
function snapshotCurrentEditor(tab: TabState): void {
  if (!editorView) {
    return;
  }
  const content = getEditorContent();
  const head = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(head);
  tabManager.updateTab(tab.id, {
    content,
    savedCursor: { line: line.number, ch: head - line.from },
  });
  cancelPendingAutoSave(tab);
}

/** 恢复目标标签在快照中记录的光标位置并聚焦。 */
function restoreTargetCursor(tab: TabState): void {
  if (!editorView || !tab.savedCursor) {
    return;
  }
  const { line, ch } = tab.savedCursor;
  const maxLine = Math.max(1, editorView.state.doc.lines);
  const docLine = editorView.state.doc.line(Math.min(line, maxLine));
  const position = Math.min(docLine.from + ch, docLine.to);
  editorView.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position),
  });
}

/** 切换到指定标签：快照当前标签 → 激活目标 → 载入目标 → 恢复光标。 */
function switchToTab(targetId: number): void {
  const current = tabManager.getActive();
  if (!current || current.id === targetId) {
    return;
  }
  snapshotCurrentEditor(current);
  tabManager.activate(targetId);
  loadActiveTabIntoEditor();
  restoreTargetCursor(getActiveTab());
  editorView.focus();
  queueSpellcheck();
}

/** 新建一个「未命名」标签并切换过去。 */
function newTab(): void {
  const current = tabManager.getActive();
  if (current) {
    snapshotCurrentEditor(current);
  }
  tabManager.openNew(untitledTitle(), "");
  loadActiveTabIntoEditor();
  setStatus(translate("newDocument"));
  editorView.focus();
}

/** 关闭指定标签。若目标标签有未保存修改，先弹窗确认（丢弃/取消）。 */
function closeTab(id: number): void {
  const target = tabManager.getAll().find((tab) => tab.id === id);
  if (!target) {
    return;
  }
  const closingActive = tabManager.getActive()?.id === id;

  void (async () => {
    let proceed = true;
    if (target.dirty) {
      proceed = await confirm(
        translate("closeDirtyMessage", { title: target.title }),
        { title: translate("closeDirtyTitle"), kind: "warning" },
      );
    }
    if (!proceed) {
      return;
    }
    // 关闭的最后标签由 TabManager 的「保底未命名标签」规则兜底。
    const closed = tabManager.close(id, untitledTitle(), "");
    if (closingActive && closed !== null) {
      loadActiveTabIntoEditor();
      editorView.focus();
    }
  })();
}

/** 循环切换标签：delta = 1 下一个，-1 上一个。 */
function cycleTabs(delta: number): void {
  const tabs = tabManager.getAll();
  if (tabs.length < 2) {
    return;
  }
  const activeId = tabManager.getActive()?.id ?? -1;
  const currentIndex = tabs.findIndex((tab) => tab.id === activeId);
  const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
  switchToTab(tabs[nextIndex].id);
}

async function loadPendingLaunchFile(): Promise<OpenedExternalFile | null> {
  try {
    const pendingPath = await invoke<string | null>("take_pending_launch_path");
    if (!pendingPath) {
      return null;
    }
    return await invoke<OpenedExternalFile>("open_external_file", {
      path: pendingPath,
    });
  } catch (error) {
    setStatus(translate("launchFailed", { error: String(error) }));
    return null;
  }
}

async function listenForCliFileOpenEvent(): Promise<void> {
  await listen<string>("open-file-from-cli", async (event) => {
    try {
      const opened = await invoke<OpenedExternalFile>("open_external_file", {
        path: event.payload,
      });
      await openDocumentInTab(opened);
    } catch (error) {
      setStatus(translate("contextOpenFailed", { error: String(error) }));
    }
  });
}

function runEditorCommand(command: (view: EditorView) => boolean): void {
  if (!editorView) {
    return;
  }
  command(editorView);
  editorView.focus();
}

async function executeAppCommand(command: string): Promise<void> {
  switch (command) {
    case "file.open":
      await handleImportMarkdown();
      break;
    case "file.save":
      await handleSaveFile();
      break;
    case "edit.undo":
      runEditorCommand(undo);
      break;
    case "edit.redo":
      runEditorCommand(redo);
      break;
    case "edit.find":
    case "edit.replace":
      runEditorCommand(openSearchPanel);
      break;
    case "edit.find_next":
      runEditorCommand(findNext);
      break;
    case "edit.find_previous":
      runEditorCommand(findPrevious);
      break;
    case "view.editor":
      setDisplayMode("editor");
      break;
    case "view.preview":
      setDisplayMode("preview");
      break;
    case "view.split":
      setDisplayMode("split");
      break;
    case "view.theme.system":
      applyTheme("system");
      break;
    case "view.theme.light":
      applyTheme("light");
      break;
    case "view.theme.dark":
      applyTheme("dark");
      break;
    case "language.system":
      await saveLanguagePreference("system");
      break;
    case "language.zh-CN":
      await saveLanguagePreference("zh-CN");
      break;
    case "language.en":
      await saveLanguagePreference("en");
      break;
  }
}

async function listenForMenuActions(): Promise<void> {
  await listen<string>("menu-action", (event) => {
    void executeAppCommand(event.payload);
  });
}

async function initEditor(initialFile: OpenedExternalFile | null = null): Promise<void> {
  if (initialFile) {
    persistDocumentBaseDir(initialFile.baseDir);
    tabManager.openPath({
      title: titleFromPath(initialFile.path),
      path: initialFile.path,
      baseDir: initialFile.baseDir,
      readOnly: initialFile.readOnly,
      fingerprint: initialFile.fingerprint,
      content: initialFile.content,
    });
  } else {
    tabManager.openNew(untitledTitle(), "");
  }
  const active = getActiveTab();

  editorView = new EditorView({
    state: EditorState.create({
      doc: active.content,
      extensions: [
        basicSetup,
        documentSearchKeymap,
        spellingIssueField,
        EditorView.lineWrapping,
        themeCompartment.of(getEditorTheme()),
        editableCompartment.of(EditorView.editable.of(!active.readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const latest = update.state.doc.toString();
            void renderPreview(latest).then(() => {
              syncPreviewToEditor(update.view, getEditorTopVisibleLine(update.view));
            });
            // 程序化载入（切标签/打开文件）不标脏、不排自动保存。
            if (suppressDocChanged) {
              return;
            }
            setDirtyState(true);
            setStatus(translate("unsaved"));
            queueAutoSave();
            queueSpellcheck();
            return;
          }

          if (update.selectionSet) {
            syncPreviewToEditor(update.view);
            return;
          }
        }),
      ],
    }),
    parent: editorRootEl,
  });
  editorView.scrollDOM.addEventListener("scroll", schedulePreviewSyncToEditorScroll, {
    passive: true,
  });

  updateWindowTitle(active);
  await renderPreview(active.content);
  if (active.path !== null) {
    if (active.readOnly) {
      setStatus(translate("readOnlyOpened", { path: active.path }));
    } else {
      setStatus(translate("opened", { path: active.path }));
    }
  } else {
    setStatus(translate("newDocument"));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  applyTheme(themePreference, false);
  setDisplayMode("preview");
  void (async () => {
    await initializeLanguage();
    // 订阅标签集合变化：重建标签栏 + 更新窗口标题。需在 initEditor 之前，
    // 使首个标签创建即触发渲染。
    tabManager.onDidChange((active) => {
      renderTabBar();
      if (active) {
        updateWindowTitle(active);
      }
    });
    const initialFile = await loadPendingLaunchFile();
    await initEditor(initialFile);
    await listenForCliFileOpenEvent();
    await listenForMenuActions();
    await initializeSpellchecker();
  })();

  previewEl.addEventListener("click", handlePreviewClick);

  tabBarEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const closeEl = target.closest<HTMLElement>(".tab-close");
    if (closeEl) {
      event.preventDefault();
      event.stopPropagation();
      const id = Number(closeEl.dataset.closeFor);
      closeTab(id);
      return;
    }
    const tabEl = target.closest<HTMLElement>(".tab");
    if (tabEl && tabEl.dataset.tabId) {
      switchToTab(Number(tabEl.dataset.tabId));
    }
  });
  tabNewButtonEl.addEventListener("click", () => {
    newTab();
  });

  splitDividerEl.addEventListener("pointerdown", handleSplitPointerDown);
  document.addEventListener("pointermove", handleSplitPointerMove);
  document.addEventListener("pointerup", handleSplitPointerEnd);
  document.addEventListener("pointercancel", handleSplitPointerEnd);
  window.addEventListener("resize", applySplitRatio);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themePreference === "system") {
      applyTheme("system", false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const displayModeByKey: Record<string, DisplayMode> = {
        "1": "editor",
        "2": "preview",
        "3": "split",
      };
      const mode = displayModeByKey[event.key];
      if (mode) {
        event.preventDefault();
        setDisplayMode(mode);
        return;
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void handleSaveFile();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      newTab();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      const active = tabManager.getActive();
      if (active) {
        closeTab(active.id);
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
      event.preventDefault();
      cycleTabs(event.shiftKey ? -1 : 1);
      return;
    }
  });
});
