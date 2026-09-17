# LightNote 多文档标签页重构实施计划

> 目标：在不破坏现有安全不变量（自动保存、乐观并发控制、冲突提示、路径包含校验）的前提下，把「单文档单窗口」重构为「多文档标签页」。
> 已确认的四项交互决策：① 同路径文件**自动去重**；② 非激活标签**仅保留字符串缓冲**；③ 关闭脏标签**弹窗确认（丢弃/取消）**；④ 关闭最后一个标签后**保留一个空的「未命名」标签**。

---

## 0. 现状与改造结论

### 0.1 为什么是「架构重构」而非「加功能」

核心瓶颈在 `src/main.ts`：约 15 个**模块级单例变量**把整个文档生命周期钉死在「全局一份」上。多标签的本质工作是把它们收敛为「每标签一份」，并把依赖这些全局量的函数（渲染、保存、冲突、滚动同步、拼写检查）改为「作用于当前激活标签」。

Rust 层是**利好**：`src-tauri/src/lib.rs` 的全部命令（`save_external_file` / `open_external_file` / `read_local_image` / `spellcheck_document` / 语言偏好 / 单实例）都以**参数传递数据、不读窗口状态**，多标签场景下**几乎零改动**。

### 0.2 需收敛的模块级全局状态（`main.ts:353-369` 等）

| 全局变量 | 归属 | 多标签处理 |
|---------|------|-----------|
| `editorView` | 全局 | 保持**唯一**，仅挂载激活标签 |
| `documentPath` | Tab | → `tab.path` |
| `documentBaseDir` | Tab | → `tab.baseDir` |
| `documentReadOnly` | Tab | → `tab.readOnly` |
| `documentFingerprint` | Tab | → `tab.fingerprint` |
| `autoSaveTimer` | Tab | → `tab.autoSaveTimer`（或 TabManager 管理） |
| `autoSavePausedForConflict` | Tab | → `tab.conflictPaused` |
| `spellcheckTimer` / `spellcheckRequestId` | 激活标签才相关 | 全局保留（仅激活标签拼写检查） |
| `previewObjectUrls` | 激活标签才相关 | 全局保留（仅激活标签渲染） |
| `previewRenderId` / `mermaidRenderId` | 激活标签 | 全局保留 |
| `documentBaseDir` localStorage 持久化 | 全局 | **仅记忆最后访问目录**，移除单值语义 |

---

## 1. 目标架构

### 1.1 数据模型（新增 `src/tabs.ts`）

```ts
// src/tabs.ts —— 标签状态与 TabManager
export interface TabState {
  id: string;              // 实例唯一标识（自增计数器）
  title: string;           // 标签标题：文件名 or "未命名"
  path: string | null;     // 已保存文件的规范化路径；未命名 = null
  baseDir: string | null;  // 相对图片解析目录
  readOnly: boolean;
  fingerprint: string | null;   // 乐观并发控制指纹
  content: string;              // 当前文本缓冲区（非激活标签保活）
  dirty: boolean;               // 是否有未保存修改
  conflictPaused: boolean;      // 命中 FILE_CHANGED_EXTERNALLY 后暂停自动保存
  autoSaveTimer: number | null; // 该标签的自动保存延迟定时器
  savedCursor: { line: number; ch: number } | null; // 记录切走时的光标/滚动
}
```

### 1.2 核心运行模型

```
┌───────────────────────────────┐
│   TabManager                  │
│  - tabs: TabState[]           │
│  - activeId: string           │
│  + openNew()                  │  新建未命名标签
│  + openPath(path)             │  打开已有文件（自动去重→激活）
│  + activate(id)               │  切换（先落盘旧标签内容）
│  + close(id)                  │  关闭（脏标签确认）
│  + getActive(): TabState      │
│  + createView/showView()      │  挂载 CodeMirror 到 #editor
└───────────────────────────────┘
```

- **唯一 CodeMirror 实例**：`editorView` 常驻 `#editor` DOM 节点，不增删。切换标签时：
  1. 把当前 `editorView` 的 `doc.toString()` 写回 `旧Tab.content`，记录光标→`savedCursor`；
  2. 用 `replaceEditorText(新Tab.content)` 载入新内容；
  3. 恢复新 Tab 的 `savedCursor`（若有）；
  4. 触发该 Tab 的预览渲染。
- **非激活标签不渲染预览**：不持有 blob URL、不持有 Mermaid 输出，切回时重新渲染。这让预览竞态控制（`previewRenderId`）天然只对激活标签有效。

### 1.3 内存与资源模型

| 资源 | 激活标签 | 非激活标签 |
|------|---------|-----------|
| CodeMirror view | ✅ 挂载 | ❌ 不挂载（仅存 `content` 字符串） |
| 预览 HTML / blob URL | ✅ 持有 | ❌ 无 |
| 撤销历史 | ✅ 由 CodeMirror 持有 | ❌ 保存于 `content` 字符串；切换后丢失 |
| 拼写检查结果 | ✅ | ❌ |

> ⚠️ **已知取舍**：非激活标签切换后**撤销历史会丢失**（CodeMirror 的 history 无法简单序列化）。首版接受此取舍；若需保留，后续可引入每条 Tab 独立挂载 view（成本显著上升，见 §7.2）。

---

## 2. 分步实施（每步可独立验证、可回退）

### 步骤 A — 建立标签数据模型与 TabManager（纯新增，无行为变更）

**改动文件**：新增 `src/tabs.ts`；`index.html`、`styles.css` 加标签栏骨架。

1. 在 `src/tabs.ts` 实现 `TabState` 类型与 `TabManager` 类，**仅做内存管理**：`openNew`、`openPath`（含**同路径去重**：若已存在 `tabs.find(t => t.path === path)` 则返回该 tab 而非新建）、`activate`、`close`。
2. `index.html` 的 `.topbar` 内或上方新增 `<nav id="tab-bar"></nav>`。
3. `styles.css` 新增标签栏样式（`.tab`, `.tab.active`, `.tab-close` 等）。
4. **暂不接入 `main.ts`**：本步只是把数据结构和 UI 骨架搭好，用 `npm run build`（`tsc && vite build`）验证可编译。

**验收**：`npm run build` 通过；无运行时行为变化。

---

### 步骤 B — 将 `main.ts` 全局文档状态迁移到 TabManager（核心重构）

**改动文件**：`src/main.ts`（本轮改动最大的文件）。

原则：**逐项替换**，每替换一项跑一次 `npm run build`，保持可编译。

1. 用 `activeTab`（`tabManager.getActive()`）替换 `documentPath`、`documentReadOnly`、`documentFingerprint`、`autoSavePausedForConflict` 的**读写点**。涉及函数：
   - `queueAutoSave`（`main.ts:606`）→ 读 `activeTab.conflictPaused / readOnly`，定时器存 `activeTab.autoSaveTimer`；
   - `saveCurrentDocument`（`main.ts:681`）→ 读/写 `activeTab.path / fingerprint`，出错后置 `activeTab.conflictPaused`；
   - `handleSaveFile`（`main.ts:1036`）→ 保存成功后写回 `activeTab`；
   - `handleImportMarkdown` / `applyOpenedExternalFile`（`main.ts:1010/1088`）→ 改为「打开新标签」语义；
   - `renderPreview`（`main.ts:987`）→ 读取 `activeTab.baseDir`（替换 `documentBaseDir`）。
2. **保留**全局 `editorView`、`spellcheckTimer`、`spellcheckRequestId`、`previewObjectUrls`、`previewRenderId`、`mermaidRenderId` —— 它们只服务激活标签，无需入 tab。
3. **`documentBaseDir` 的 localStorage 持久化降级**：`DOCUMENT_BASE_DIR_STORAGE_KEY` 从「当前文档目录」改为「最后访问目录」，仅作为新 `openNew` 时的默认提示，不再是一份文档的专属状态（一个标签对应一个 `baseDir`，存在 tab 里）。

**验收**：逐一打开/保存/另存自测；确认自动保存、冲突提示、只读打开、本地图片渲染**行为与重构前完全一致**。

---

### 步骤 C — 接入标签 UI 生命周期

**改动文件**：`src/main.ts`、`src/tabs.ts`、`index.html`、`styles.css`。

1. `TabManager` 对外暴露 `onChange(callback)` 或由 `main.ts` 在增删/切换后调用渲染函数：
   - 渲染标签栏（标题、激活态、关闭按钮）；
   - 更新窗口 `document.title`（取激活标签标题）；
   - 更新状态栏（`#save-status`）为激活标签的状态。
2. 实现**切换**：`activate(id)` 内部完成「旧 Tab 内容写回 → replaceEditorText 载入新 Tab → 恢复光标 → 触发预览渲染」。
3. 实现**新建**：顶部 `+` 按钮或键盘快捷键（如 `Ctrl+N`）→ `openNew()` → 激活并注入 `initialText`（现 `main.ts:67/100` 的欢迎文案）。
4. 实现**关闭 X 按钮**：调 `close(id)`。
5. 实现**同文件去重**：`openPath` 命中已有 tab 时直接 `activate` 之，不新建（含 CLI 打开路径）。

**验收**：多标签切换、新建、关闭、同文件自动去重，鼠标操作全部可用；状态栏/标题跟随激活标签。

---

### 步骤 D — 脏标签保护与「最后一个标签」规则

**改动文件**：`src/main.ts`、`src/tabs.ts`。

1. `close(id)` 中：若 `tab.dirty`（有未保存修改），复用现有 `confirm()` 对话框（现 `main.ts:1066` 已用），提示「有未保存修改，确定丢弃？」→ 确认则关闭，否则取消。首版**不提供**“保存后关闭”选项（§四确认的决策）。
2. 每次文本修改（`EditorView.updateListener` 的 `docChanged` 分支，`main.ts:1225`）把 `activeTab.dirty = true`；自动保存成功 / 手动保存成功后置 `false`。
3. **最后一个标签规则**：`close(id)` 若将导致 `tabs.length === 0`，则调用 `openNew()` 创建一个空的「未命名」标签并激活，保证窗口始终至少有一个标签。
4. 关闭标签时**撤销残留资源**：若关闭的是激活标签，先按激活切换流程落盘内容，再销毁；若其持有 `previewObjectUrls`，调用 `URL.revokeObjectURL` 释放。

**验收**：修改后不保存即关闭 → 出现确认弹窗；取消不关、确认丢弃；关闭最后一个标签后出现新的空「未命名」标签。

---

### 步骤 E — 命令分发与 CLI/单实例接入

**改动文件**：`src/main.ts`、`src-tauri/src/lib.rs`（仅注释/语义确认，逻辑基本不变）。

1. **菜单命令**（`executeAppCommand`，`main.ts:1143`）：`file.open` → 打开新标签；`file.save` → 保存激活标签；`edit.*` / `view.*` / 主题 / 语言 → 作用于激活标签（多数已通过替换后的 `activeTab` 自动收敛，仅需复核）。
2. **CLI / 单实例**（Rust `lib.rs:528-541`）：
   - `open-file-from-cli` 事件：`main.ts:1122` 现在「覆盖当前文档」→ 改为「`openPath` + 自动去重 + activate」。
   - `take_pending_launch_path`：`main.ts:1107` 启动时读待打开路径 → 改为「`openPath`，无待打开路径时 `openNew`」。
   - Rust 侧逻辑**不改**（single-instance 聚焦窗口 + 发事件已足够）。
3. 为标签栏增加键盘支持（可选）：`Ctrl+Tab` / `Ctrl+Shift+Tab` 循环切换；`Ctrl+W` 关闭当前标签（需与现有 `Ctrl+P` 等无冲突）。

**验收**：从文件资源管理器/命令行双击 `.md` 打开 → 若已开则切到已有标签，否则新增标签；菜单各项对激活标签生效。

---

### 步骤 F — 回归验证与收尾

**改动文件**：无新增功能，只做验证与清理。

1. 跑 `npm run build`（`tsc` strict 模式下，`main.ts` 全部 `activeTab` 引用类型正确）。
2. 跑 `cargo check --manifest-path src-tauri/Cargo.toml` 确认 Rust 未破坏。
3. 人工回归清单（对应 CLAUDE.md 的安全不变量）：
   - [ ] 停止编辑 1 秒后自动保存；
   - [ ] 外部修改文件 → `FILE_CHANGED_EXTERNALLY` → 自动保存暂停 + 手动保存询问覆盖；
   - [ ] 只读文件打开 → 状态栏提示 + 编辑器只读；
   - [ ] 预览中相对路径图片按「激活标签的 baseDir」解析；
   - [ ] 编辑器↔预览滚动同步仅在 split 模式下工作；
   - [ ] 同路径文件去重；关闭脏标签确认；最后一个标签不消失。
4. （可选，若新增测试）为 `TabManager` 的纯逻辑（去重、lastTab 规则、dirty 判断）补若干单元测试。当前仓库无测试脚本；如需，在 `src/tabs.test.ts` 用纯函数导出 TabManager 核心逻辑。

**验收**：全清单通过；`npm run build` 与 `cargo check` 全绿。

---

## 3. 文件改动总览

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/tabs.ts`（新增） | 新增 | `TabState` + `TabManager`（纯内存逻辑，易测） |
| `src/main.ts` | 大改 | 全局状态→activeTab；open/save/render/命令分发改造 |
| `index.html` | 小改 | `.topbar` 增加 `#tab-bar` 标签栏骨架 |
| `src/styles.css` | 中改 | 标签栏样式、激活态、关闭按钮 |
| `src-tauri/src/lib.rs` | 基本不改 | 仅复核命令语义；单实例/CLI 复用现有事件 |
| `scripts/` / `tauri.conf.json` | 不改 | 无打包影响 |

---

## 4. 关键实现陷阱与对策

1. **状态串台**（最易犯）：`main.ts` 中任何残留的 `documentPath` 等全局引用都会跨标签泄漏。对策：步骤 B 逐项替换 + 每步 `npm run build`；完成后全局 grep `documentPath|documentBaseDir|documentFingerprint|documentReadOnly` 确认无残留。
2. **切换保存时序**：切走标签前先**同步**把 `editorView.doc.toString()` 写回 `content`；但不强求切走时立即落盘（自动保存在后台进行，`saveQueue` 串行保证不互相超越）。
3. **blob URL 泄漏**：仅激活标签创建 `previewObjectUrls`；关闭时若该标签持有（理论上关闭即激活→已切走），在 `renderPreview` 每次渲染前 `revokePreviewObjectUrls()`（现逻辑 `main.ts:989` 已如此）保持不变即可。
4. **Mermaid 重复 id**：`renderMermaidNodes` 用 `mermaidRenderId` 全局递增生成 `id`（`main.ts:732`），切换多次标签会复现相同内容渲染，重复 id 可能导致 Mermaid 缓存冲突——对策：切标签后**强制刷新一次预览**（`previewRenderId++` 并重新 `renderPreview`），必要时清空 Mermaid 的 `init` 缓存 key。
5. **撤销历史丢失**：接受并在文档中注明；不作为首版缺陷。
6. **同文件并发指纹**：两个标签指向同一文件被去重拦截（决策①），故不会出现「双标签各自跟踪指纹」的场景。

---

## 5. 提交（commit）切分建议

每个步骤对应 1~2 个独立 commit，保证每个 commit 可编译、可运行、可回退：

```
A1  feat: add TabState type and TabManager skeleton + tab bar UI
B1  refactor: migrate document globals to activeTab (path/baseDir/fingerprint/readOnly)
B2  refactor: migrate autosave/conflict state into activeTab
C1  feat: wire tab switching/new/close UI into TabManager
D1  feat: dirty-tab confirm on close + keep-one-untitled rule
E1  feat: route menu + CLI/single-instance opens into tab flow
F1  test: cover TabManager logic + regression checklist
```

---

## 6. 完成定义（Definition of Done）

- [ ] 多标签增/删/切、同路径自动去重、关闭脏标签确认、最后标签不消失全部可用；
- [ ] 菜单、CLI、双击文件打开都走标签流程；
- [ ] 自动保存、冲突检测、只读、图片渲染、滚动同步行为与重构前一致；
- [ ] `npm run build` 与 `cargo check` 全绿；
- [ ] 无残留的单例文档状态引用（grep 验证）。

---

## 7. 后续可选增强（不在本次范围）

### 7.1 多窗口（对照参考）
多窗口是完全不同量级：需要移除 single-instance、每窗口独立 WebView、Rust 层按窗口隔离状态。本次多标签方案**不依赖**多窗口，且多窗口本质上要复用「每标签一套文档状态」的抽象，标签是更稳的地基。

### 7.2 保留非激活标签的完整撤销历史
若未来需要，可演进为「每标签独立挂载 CodeMirror view」——内存与复杂度显著上升（每标签一套渲染管线），当前**不建议**首版做。