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
const statusEl = document.querySelector("#save-status") as HTMLSpanElement;
const editorRootEl = document.querySelector("#editor") as HTMLDivElement;
const previewEl = document.querySelector("#preview") as HTMLDivElement;

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
    return `<div class="mermaid">${escapeHtml(normalizeMermaidSource(token.content))}</div>`;
  }
  return rawFenceRenderer
    ? rawFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

let mermaidLib: typeof import("mermaid") | null = null;
type DisplayMode = "editor" | "preview" | "split";
const editableCompartment = new Compartment();

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
let documentBaseDir: string | null = null;
let previewObjectUrls: string[] = [];

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

  if (mode !== "editor" && editorView) {
    void renderPreview(getEditorContent());
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
      } catch {
        return;
      }
    }),
  );
}

async function renderPreview(content: string): Promise<void> {
  const renderId = ++previewRenderId;
  revokePreviewObjectUrls();
  const html = markdownRenderer.render(normalizeMarkdownFences(content));
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
  const content = (await invoke<string>("load_document")) || INITIAL_TEXT;

  editorView = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }
          const latest = update.state.doc.toString();
          void renderPreview(latest);
          queueSave(latest);
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
