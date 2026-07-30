import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import DOMPurify from "dompurify";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import {
  blockMathField,
  codeBlockField,
  collapseOnSelectionFacet,
  editorTheme,
  livePreviewPlugin,
  markdownStylePlugin,
  mathPlugin,
  mouseSelectingField,
  setMouseSelecting,
  tableField,
} from "codemirror-live-markdown";
import "katex/dist/katex.min.css";

const appShellEl = document.querySelector(".app-shell") as HTMLElement;
const statusEl = document.querySelector("#save-status") as HTMLSpanElement;
const editorRootEl = document.querySelector("#editor") as HTMLDivElement;
const previewEl = document.querySelector("#preview") as HTMLDivElement;

const viewToggleBtn = document.querySelector("#view-toggle-btn") as HTMLButtonElement;
const openFileBtn = document.querySelector("#open-file-btn") as HTMLButtonElement;
const moreBtn = document.querySelector("#more-btn") as HTMLButtonElement;
const moreMenuEl = document.querySelector("#more-menu") as HTMLDivElement;
const exportMdBtn = document.querySelector("#export-md-btn") as HTMLButtonElement;
const exportHtmlBtn = document.querySelector("#export-html-btn") as HTMLButtonElement;
const exportPdfBtn = document.querySelector("#export-pdf-btn") as HTMLButtonElement;

const INITIAL_TEXT = `# LightNote\n\n欢迎使用轻笺，一个轻量、离线优先的 Markdown 编辑器。\n\n- 支持自动保存到 SQLite\n- 支持 KaTeX 公式\n- 支持 Mermaid 流程图\n\n行内公式：$E = mc^2$\n\n块公式：\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n\`\`\`mermaid\nflowchart TD\n  A[Start] --> B{Need Review?}\n  B -- Yes --> C[Edit Markdown]\n  B -- No --> D[Export PDF]\n\`\`\`\n`;

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
  const info = token.info.trim();
  if (info === "mermaid") {
    return `<div class="mermaid">${token.content}</div>`;
  }
  return rawFenceRenderer
    ? rawFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

let mermaidLib: typeof import("mermaid") | null = null;
let splitMode = false;
const livePreviewCompartment = new Compartment();

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

function setSplitMode(next: boolean): void {
  splitMode = next;
  appShellEl.classList.toggle("split-mode", splitMode);
  viewToggleBtn.textContent = splitMode ? "切回单栏" : "左右分栏";
  if (editorView) {
    editorView.dispatch({
      effects: livePreviewCompartment.reconfigure(createLivePreviewExtensions(!splitMode)),
    });
  }
}

function closeMoreMenu(): void {
  moreMenuEl.hidden = true;
  moreBtn.setAttribute("aria-expanded", "false");
}

function toggleMoreMenu(): void {
  const nextHidden = !moreMenuEl.hidden;
  moreMenuEl.hidden = nextHidden;
  moreBtn.setAttribute("aria-expanded", String(!nextHidden));
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function createLivePreviewExtensions(enabled: boolean) {
  return [
    collapseOnSelectionFacet.of(enabled),
    mouseSelectingField,
    livePreviewPlugin,
    markdownStylePlugin,
    editorTheme,
    mathPlugin,
    blockMathField,
    tableField,
    ...codeBlockField({ copyButton: true, defaultLanguage: "text" }),
  ];
}

async function renderMermaidNodes(container: HTMLElement): Promise<void> {
  const nodes = Array.from(container.querySelectorAll(".mermaid")) as HTMLElement[];
  if (nodes.length === 0) {
    return;
  }
  try {
    const mermaid = await getMermaid();
    await mermaid.default.run({ nodes, suppressErrors: true });
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

async function renderPreview(content: string): Promise<void> {
  const html = markdownRenderer.render(content);
  const sanitizedHtml = DOMPurify.sanitize(html);
  previewEl.innerHTML = sanitizedHtml;
  await renderMermaidNodes(previewEl);
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

    const content = await readTextFile(selected);
    cancelQueuedSave();
    replaceEditorText(content);
    await renderPreview(content);
    await persistDocument(content);
    setStatus(`已打开: ${selected}`);
  } catch (error) {
    setStatus(`打开文件失败: ${String(error)}`);
  }
}

async function handleExportMarkdown(): Promise<void> {
  const path = await save({
    defaultPath: "note.md",
    filters: [
      {
        name: "Markdown",
        extensions: ["md"],
      },
    ],
  });

  if (!path) {
    return;
  }

  await writeTextFile(path, getEditorContent());
  setStatus(`已导出 MD: ${path}`);
}

function buildExportableHtml(content: string): string {
  const html = markdownRenderer.render(content);
  const sanitized = DOMPurify.sanitize(html);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Markdown Export</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
    <style>
      body { font-family: "Times New Roman", "Noto Serif SC", serif; max-width: 860px; margin: 40px auto; line-height: 1.75; padding: 0 20px; }
      pre { background: #f3f4f6; border: 1px solid #e5e7eb; padding: 12px; overflow: auto; border-radius: 8px; }
      code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
      blockquote { border-left: 4px solid #d1d5db; margin: 0; padding-left: 12px; color: #4b5563; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #d1d5db; padding: 6px 8px; }
      .mermaid { text-align: center; }
    </style>
  </head>
  <body>
    ${sanitized}
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <script>
      mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: "neutral" });
    </script>
  </body>
</html>`;
}

async function handleExportHtml(): Promise<void> {
  const path = await save({
    defaultPath: "note.html",
    filters: [
      {
        name: "HTML",
        extensions: ["html"],
      },
    ],
  });

  if (!path) {
    return;
  }

  await writeTextFile(path, buildExportableHtml(getEditorContent()));
  setStatus(`已导出 HTML: ${path}`);
}

function handleExportPdf(): void {
  const previousSplitMode = splitMode;
  setSplitMode(true);
  const restore = () => {
    if (!previousSplitMode) {
      setSplitMode(false);
    }
  };
  window.addEventListener("afterprint", restore, { once: true });
  window.setTimeout(() => {
    window.print();
  }, 40);
}

async function initEditor(): Promise<void> {
  const content = (await invoke<string>("load_document")) || INITIAL_TEXT;

  editorView = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        markdown({ extensions: [Table] }),
        EditorView.lineWrapping,
        livePreviewCompartment.of(createLivePreviewExtensions(true)),
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

  editorView.contentDOM.addEventListener("mousedown", () => {
    editorView.dispatch({ effects: setMouseSelecting.of(true) });
  });
  document.addEventListener("mouseup", () => {
    window.requestAnimationFrame(() => {
      editorView.dispatch({ effects: setMouseSelecting.of(false) });
    });
  });

  await renderPreview(content);
  setStatus("已从 SQLite 恢复文档");
}

window.addEventListener("DOMContentLoaded", () => {
  setSplitMode(false);
  void initEditor();

  viewToggleBtn.addEventListener("click", () => {
    setSplitMode(!splitMode);
  });

  openFileBtn.addEventListener("click", () => {
    void handleImportMarkdown();
  });

  moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMoreMenu();
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (!moreMenuEl.contains(target) && !moreBtn.contains(target)) {
      closeMoreMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMoreMenu();
    }
  });

  exportMdBtn.addEventListener("click", () => {
    closeMoreMenu();
    void handleExportMarkdown();
  });
  exportHtmlBtn.addEventListener("click", () => {
    closeMoreMenu();
    void handleExportHtml();
  });
  exportPdfBtn.addEventListener("click", () => {
    closeMoreMenu();
    handleExportPdf();
  });
});
