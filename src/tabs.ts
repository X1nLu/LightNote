/**
 * 多文档标签页的状态模型与管理器。
 *
 * 设计原则：
 * - 本模块只管理「内存中的标签状态」，不含任何 DOM / 编辑器逻辑，
 *   以便纯逻辑部分（去重、最后标签规则、dirty 判断）可独立测试。
 * - 渲染、CodeMirror 挂载、预览等副作用全部交给 main.ts 通过订阅
 *   onDidChange 处理。
 * - 同一路径只允许一个标签（自动去重）；关闭最后一个标签时自动
 *   补一个空的「未命名」标签（keep_one_untitled）。
 */

export interface TabSavedCursor {
  line: number;
  ch: number;
}

export interface TabState {
  /** 实例唯一标识（自增）。 */
  id: number;
  /** 标签标题：文件名或「未命名」。 */
  title: string;
  /** 已保存文件的规范化路径；未保存的「未命名」标签为 null。 */
  path: string | null;
  /** 相对图片解析目录。 */
  baseDir: string | null;
  /** 只读标记。 */
  readOnly: boolean;
  /** 乐观并发控制指纹（磁盘内容的 SHA-256）。 */
  fingerprint: string | null;
  /** 当前文本缓冲（非激活标签的保活字段）。 */
  content: string;
  /** 是否有未保存修改。 */
  dirty: boolean;
  /** 命中 FILE_CHANGED_EXTERNALLY 后暂停自动保存。 */
  conflictPaused: boolean;
  /** 该标签的自动保存延迟定时器。 */
  autoSaveTimer: number | null;
  /** 切走时记录的光标位置，恢复时用。 */
  savedCursor: TabSavedCursor | null;
}

/** 打开文件时用于创建 Tab 的初始化数据（区别于「未命名」标签）。 */
export interface TabInit {
  title: string;
  path: string | null;
  baseDir: string | null;
  readOnly: boolean;
  fingerprint: string | null;
  content: string;
}

export class TabManager {
  private tabs: TabState[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  /** 标签集合变化（增/删/激活切换）时触发；参数为变化后的 activeTab。 */
  private listeners: Array<(active: TabState | null) => void> = [];

  /**
   * 创建一个新的「未命名」标签并激活，返回它。
   * 自动去重：若已存在 path 相同的标签，直接激活并返回该标签（不会新建）。
   */
  openPath(init: TabInit): TabState {
    if (init.path !== null) {
      const existing = this.tabs.find((tab) => tab.path === init.path);
      if (existing) {
        this.setActive(existing.id);
        return existing;
      }
    }
    return this.createAndActivate(init);
  }

  /** 新建一个空的「未命名」标签并激活。 */
  openNew(untitledTitle: string, initialContent: string): TabState {
    return this.createAndActivate({
      title: untitledTitle,
      path: null,
      baseDir: null,
      readOnly: false,
      fingerprint: null,
      content: initialContent,
    });
  }

  /** 激活指定标签（无效 id 时忽略）。 */
  activate(id: number): void {
    this.setActive(id);
  }

  /**
   * 关闭指定标签。
   * 遵循「最后一个标签不消失」规则：若 closeContent 传入空标签时不允许
   * 变空，则在关闭最后一个标签后自动补一个「未命名」标签。
   * 返回被关闭标签之前是否是激活标签（供调用方决定是否要做切换渲染）。
   * 关闭不存在的 id 返回 null。
   */
  close(id: number, untitledTitle: string, untitledContent: string): TabState | null {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return null;
    }
    const removed = this.tabs[index];
    const wasActive = removed.id === this.activeId;

    if (this.tabs.length === 1) {
      // 只剩这一个：关闭后自动保留一个「未命名」标签。
      this.tabs.length = 0;
      const fresh = this.createTab({
        title: untitledTitle,
        path: null,
        baseDir: null,
        readOnly: false,
        fingerprint: null,
        content: untitledContent,
      });
      this.activeId = fresh.id;
      this.notify(fresh);
      return wasActive ? removed : null;
    }

    this.tabs.splice(index, 1);
    if (wasActive) {
      // 激活被关：激活相邻标签（优先右侧，越界取左侧）。
      const nextIndex = Math.min(index, this.tabs.length - 1);
      this.activeId = this.tabs[nextIndex].id;
    }
    this.notify(this.getActive());
    return wasActive ? removed : null;
  }

  getActive(): TabState | null {
    if (this.activeId === null) {
      return null;
    }
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  getAll(): readonly TabState[] {
    return this.tabs;
  }

  /** 订阅标签集合变化。返回退订函数。 */
  onDidChange(listener: (active: TabState | null) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /** 更新标签内容等字段（不改激活态）。 */
  updateTab(id: number, patch: Partial<TabState>): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) {
      return;
    }
    Object.assign(tab, patch);
  }

  /** 用新 ID 新建标签（内部用），但自动处理未命名标题去重。 */
  private createAndActivate(init: TabInit): TabState {
    const tab = this.createTab(init);
    this.activeId = tab.id;
    this.notify(tab);
    return tab;
  }

  private createTab(init: TabInit): TabState {
    const id = this.nextId++;
    const tab: TabState = {
      id,
      title: init.title,
      path: init.path,
      baseDir: init.baseDir,
      readOnly: init.readOnly,
      fingerprint: init.fingerprint,
      content: init.content,
      dirty: false,
      conflictPaused: false,
      autoSaveTimer: null,
      savedCursor: null,
    };
    this.tabs.push(tab);
    return tab;
  }

  private setActive(id: number): void {
    if (this.getActive()?.id === id) {
      return;
    }
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) {
      return;
    }
    this.activeId = id;
    this.notify(tab);
  }

  private notify(active: TabState | null): void {
    for (const listener of this.listeners) {
      listener(active);
    }
  }
}