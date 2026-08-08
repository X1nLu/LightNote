import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import DOMPurify from "dompurify";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "katex/dist/katex.min.css";

const appShellEl = document.querySelector(".app-shell") as HTMLElement;
const workspaceEl = document.querySelector(".workspace") as HTMLElement;
const statusEl = document.querySelector("#save-status") as HTMLSpanElement;
const editorRootEl = document.querySelector("#editor") as HTMLDivElement;
const previewEl = document.querySelector("#preview") as HTMLDivElement;
const splitDividerEl = document.querySelector("#split-divider") as HTMLDivElement;

const displayModeBtn = document.querySelector("#display-mode-btn") as HTMLButtonElement;
const displayModeMenuEl = document.querySelector("#display-mode-menu") as HTMLDivElement;
const displayModeOptionBtns = Array.from(
  document.querySelectorAll("[data-display-mode]"),
) as HTMLButtonElement[];
const openFileBtn = document.querySelector("#open-file-btn") as HTMLButtonElement;

const INITIAL_TEXT = `# LightNote\n\n欢迎使用轻笺，一个轻量、离线优先的 Markdown 编辑器。\n\n- 支持自动保存到 SQLite\n- 支持 KaTeX 公式\n- 支持 Mermaid 流程图\n\n行内公式：$E = mc^2$\n\n块公式：\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n\`\`\`mermaid\nflowchart TD\n  A[Start] --> B{Need Review?}\n  B -- Yes --> C[Edit Markdown]\n  B -- No --> D[Done]\n\`\`\`\n`;

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
const SPLIT_RATIO_STORAGE_KEY = "lightnote.split-pane-ratio";
const DOCUMENT_BASE_DIR_STORAGE_KEY = "lightnote.document-base-dir";
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_PANEL_WIDTH = 280;
const SPLIT_DIVIDER_WIDTH = 10;

interface OpenedExternalFile {
  path: string;
  content: string;
  readOnly: boolean;
  baseDir: string;
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
    theme: "neutral",
  });
  mermaidLib = lib;
  return lib;
}

let editorView: EditorView;
let saveTimer: number | null = null;
let mermaidRenderId = 0;
let previewRenderId = 0;
let documentBaseDir: string | null = loadDocumentBaseDir();
let previewObjectUrls: string[] = [];
let splitRatio = loadSplitRatio();
let activeSplitPointerId: number | null = null;

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

function loadDocumentBaseDir(): string | null {
  try {
    const baseDir = window.localStorage.getItem(DOCUMENT_BASE_DIR_STORAGE_KEY);
    return baseDir?.trim() || null;
  } catch {
    return null;
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

  const labelMap: Record<DisplayMode, string> = {
    editor: "显示模式（单栏编辑）",
    preview: "显示模式（单栏预览）",
    split: "显示模式（分栏）",
  };
  displayModeBtn.textContent = labelMap[mode];

  for (const optionBtn of displayModeOptionBtns) {
    optionBtn.classList.toggle("is-active", optionBtn.dataset.displayMode === mode);
  }

  applySplitRatio();

  if (mode !== "editor" && editorView) {
    void renderPreview(getEditorContent()).then(() => {
      syncPreviewToEditor(editorView);
    });
  }
}

function closeDisplayModeMenu(): void {
  displayModeMenuEl.hidden = true;
  displayModeBtn.setAttribute("aria-expanded", "false");
}

function toggleDisplayModeMenu(): void {
  const nextHidden = !displayModeMenuEl.hidden;
  displayModeMenuEl.hidden = nextHidden;
  displayModeBtn.setAttribute("aria-expanded", String(!nextHidden));
}

function setStatus(message: string): void {
  statusEl.textContent = message;
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

async function persistDocument(content: string): Promise<void> {
  try {
    await invoke("save_document", { content });
    setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatus(`保存失败: ${String(error)}`);
  }
}

function queueSave(content: string): void {
  setStatus("保存中...");
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    void persistDocument(content);
  }, 450);
}

function cancelQueuedSave(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
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

function syncPreviewToEditor(view: EditorView): void {
  if (!isSplitMode()) {
    return;
  }

  const lineNumber = view.state.doc.lineAt(view.state.selection.main.head).number;
  const block = getPreviewBlockForLine(lineNumber);
  if (!block) {
    return;
  }

  const previewRect = previewEl.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const topOffset = Math.min(72, Math.max(24, previewEl.clientHeight * 0.16));
  const targetTop =
    previewEl.scrollTop + blockRect.top - previewRect.top - topOffset;
  const maxScrollTop = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight);
  previewEl.scrollTop = clamp(targetTop, 0, maxScrollTop);
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

function handlePreviewClick(event: MouseEvent): void {
  const lineNumber = getSourceLineFromPreviewTarget(event.target);
  if (lineNumber === null) {
    return;
  }

  if (!appShellEl.classList.contains("mode-split")) {
    setDisplayMode("editor");
  }
  focusEditorLine(lineNumber);
}

async function renderPreview(content: string): Promise<void> {
  const renderId = ++previewRenderId;
  revokePreviewObjectUrls();
  const html = renderMarkdownWithSourceRanges(content);
  const sanitizedHtml = DOMPurify.sanitize(html);
  previewEl.innerHTML = sanitizedHtml;
  await loadLocalImages(previewEl, documentBaseDir, renderId);
  if (renderId !== previewRenderId) {
    return;
  }
  await renderMermaidNodes(previewEl, renderId);
}

function replaceEditorText(content: string): void {
  editorView.dispatch({
    changes: {
      from: 0,
      to: editorView.state.doc.length,
      insert: content,
    },
  });
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
      setStatus("未选择文件");
      return;
    }

    const opened = await invoke<OpenedExternalFile>("open_external_file", {
      path: selected,
    });
    await applyOpenedExternalFile(opened);
  } catch (error) {
    setStatus(`打开文件失败: ${String(error)}`);
  }
}

async function applyOpenedExternalFile(opened: OpenedExternalFile): Promise<void> {
  cancelQueuedSave();
  documentBaseDir = opened.baseDir;
  persistDocumentBaseDir(documentBaseDir);
  replaceEditorText(opened.content);
  setEditorReadOnly(opened.readOnly);
  await renderPreview(opened.content);
  await persistDocument(opened.content);
  if (opened.readOnly) {
    setStatus(`已只读打开: ${opened.path}（源文件为只读）`);
  } else {
    setStatus(`已打开: ${opened.path}`);
  }
}

async function consumePendingLaunchPath(): Promise<void> {
  try {
    const pendingPath = await invoke<string | null>("take_pending_launch_path");
    if (!pendingPath) {
      return;
    }
    const opened = await invoke<OpenedExternalFile>("open_external_file", {
      path: pendingPath,
    });
    await applyOpenedExternalFile(opened);
  } catch (error) {
    setStatus(`处理启动文件失败: ${String(error)}`);
  }
}

async function listenForCliFileOpenEvent(): Promise<void> {
  await listen<string>("open-file-from-cli", async (event) => {
    try {
      const opened = await invoke<OpenedExternalFile>("open_external_file", {
        path: event.payload,
      });
      await applyOpenedExternalFile(opened);
    } catch (error) {
      setStatus(`打开右键文件失败: ${String(error)}`);
    }
  });
}

async function initEditor(): Promise<void> {
  const storedContent = await invoke<string>("load_document");
  const content = storedContent || INITIAL_TEXT;
  if (!storedContent) {
    documentBaseDir = null;
    persistDocumentBaseDir(null);
  }

  editorView = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const latest = update.state.doc.toString();
            void renderPreview(latest).then(() => {
              syncPreviewToEditor(update.view);
            });
            queueSave(latest);
            return;
          }

          if (update.selectionSet || update.viewportChanged) {
            syncPreviewToEditor(update.view);
          }
        }),
      ],
    }),
    parent: editorRootEl,
  });

  await renderPreview(content);
  setStatus("已从 SQLite 恢复文档");
}

window.addEventListener("DOMContentLoaded", () => {
  setDisplayMode("editor");
  void (async () => {
    await initEditor();
    await consumePendingLaunchPath();
    await listenForCliFileOpenEvent();
  })();

  displayModeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleDisplayModeMenu();
  });

  for (const optionBtn of displayModeOptionBtns) {
    optionBtn.addEventListener("click", () => {
      const mode = optionBtn.dataset.displayMode as DisplayMode;
      setDisplayMode(mode);
      closeDisplayModeMenu();
    });
  }

  openFileBtn.addEventListener("click", () => {
    void handleImportMarkdown();
  });

  previewEl.addEventListener("click", handlePreviewClick);

  splitDividerEl.addEventListener("pointerdown", handleSplitPointerDown);
  document.addEventListener("pointermove", handleSplitPointerMove);
  document.addEventListener("pointerup", handleSplitPointerEnd);
  document.addEventListener("pointercancel", handleSplitPointerEnd);
  window.addEventListener("resize", applySplitRatio);

  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (!displayModeMenuEl.contains(target) && !displayModeBtn.contains(target)) {
      closeDisplayModeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDisplayModeMenu();
    }
  });
});
