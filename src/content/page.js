// 页面世界（MAIN world）脚本：能访问页面里的 JupyterLab / CodeMirror 对象。
// 三个平台适配器都实现同一个接口：
//   detect() -> {detected, platform, kind}
//   getActiveCellCode() -> string
//   getLastErrorOutput() -> string
//   insertCellBelow(code) -> {inserted:true}
//   runCell() -> {ran:true}
// 适配器：JupyterLab、经典 Notebook、VS Code 原生 Notebook（ModelScope Code Editor）、Kaggle DOM 兜底。
// 注意：本脚本只把文本放进单元格，从不 eval 模型输出。
(() => {
  if (window.__nbacPageLoaded) return;
  window.__nbacPageLoaded = true;

  const H = window.__nbacHelpers; // nb-helpers.js（manifest 里先于本文件加载）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.isConnected && (el.offsetParent !== null || el.getClientRects().length));

  async function waitFor(fn, timeout = 4000, step = 80) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch { /* ignore */ }
      await sleep(step);
    }
    return null;
  }

  // ---------- 诊断：记录最近一次插入/写入的步骤和错误（不含代码内容） ----------
  let steps = [];
  let lastError = null;
  function trace(step, info) {
    steps.push(info ? { step, ...info } : { step });
    if (steps.length > 40) steps.shift();
  }

  // ---------- 通用：键盘事件 ----------
  const KEYCODES = { Escape: 27, Enter: 13, b: 66, B: 66 };
  function key(target, k, opts = {}) {
    const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, composed: true, ...opts });
      // Lumino / Jupyter 依赖 keyCode，合成事件里默认是 0，这里补上
      const kc = KEYCODES[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => kc });
        Object.defineProperty(ev, 'which', { get: () => kc });
      } catch { /* ignore */ }
      (target || document.activeElement || document.body).dispatchEvent(ev);
    }
  }

  // 模拟一次真实点击：JupyterLab 的工具栏按钮在 mousedown 时触发，普通按钮在 click 时触发
  function press(el) {
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // ---------- 通用：编辑器读写（CodeMirror 6 / 5 / Monaco / textarea / contenteditable） ----------
  function cm6View(root) {
    const content = root.matches && root.matches('.cm-content') ? root : root.querySelector && root.querySelector('.cm-content');
    if (!content) return null;
    const v = content.cmView;
    if (v && v.view && v.view.state) return v.view;
    if (v && v.rootView && v.rootView.view) return v.rootView.view;
    const ed = content.closest('.cm-editor');
    if (ed && ed.cmView && ed.cmView.view) return ed.cmView.view;
    return null;
  }

  // 找 Monaco 的命名空间：全局 window.monaco，或 AMD loader 里已经加载的 vs/editor/editor.main
  function monacoNamespace() {
    if (window.monaco && window.monaco.editor && window.monaco.editor.getEditors) return { ns: window.monaco, via: 'window.monaco' };
    const req = window.require;
    try {
      if (typeof req === 'function' && (!req.defined || req.defined('vs/editor/editor.main'))) {
        const ns = req('vs/editor/editor.main');
        if (ns && ns.editor && ns.editor.getEditors) return { ns, via: 'amd-require' };
      }
    } catch { /* 不是 AMD 或模块没加载 */ }
    return null;
  }

  function monacoInstance(monacoEl) {
    const m = monacoNamespace();
    if (!m) return null;
    const ed = m.ns.editor.getEditors().find((e) => { const d = e.getDomNode && e.getDomNode(); return d && (d === monacoEl || monacoEl.contains(d) || d.contains(monacoEl)); });
    return ed ? { ed, via: m.via } : null;
  }

  // Monaco 渲染出来的行：按 top 排序（DOM 顺序不一定等于行号顺序），&nbsp; 还原成空格
  function monacoViewText(monacoEl) {
    return H.joinViewLines(Array.from(monacoEl.querySelectorAll('.view-lines .view-line')).map((l) => ({ top: l.style.top, text: l.textContent })));
  }

  function getEditorText(root) {
    if (!root) return '';
    const view = cm6View(root);
    if (view) return view.state.doc.toString();
    const cm5 = root.matches && root.matches('.CodeMirror') ? root : root.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) return cm5.CodeMirror.getValue();
    const monacoEl = root.matches('.monaco-editor') ? root : root.querySelector('.monaco-editor');
    if (monacoEl) {
      const mi = monacoInstance(monacoEl);
      if (mi) return mi.ed.getValue();
      // 没有全局 monaco（如飞桨 AI Studio 的 BML Codelab）：读渲染出来的行。
      // Monaco 用 &nbsp; 渲染空格；超长单元格只渲染可见的行
      return monacoViewText(monacoEl);
    }
    const lines = root.querySelectorAll('.cm-line');
    if (lines.length) return Array.from(lines).map((l) => l.textContent).join('\n');
    const ta = root.matches('textarea') ? root : root.querySelector('textarea');
    if (ta && ta.value) return ta.value;
    const ce = root.querySelector('[contenteditable="true"]');
    if (ce) return ce.innerText;
    return '';
  }

  async function setEditorText(root, text) {
    const view = cm6View(root);
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return 'cm6';
    }
    const cm5 = root.matches && root.matches('.CodeMirror') ? root : root.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) { cm5.CodeMirror.setValue(text); return 'cm5'; }
    const monacoEl = root.matches('.monaco-editor') ? root : root.querySelector('.monaco-editor');
    if (monacoEl) return writeMonaco(monacoEl, text);
    // 兜底：模拟用户输入（CodeMirror 6 会处理 beforeinput/insertText）
    const ce = (root.matches('[contenteditable="true"],textarea') ? root : null) ||
      root.querySelector('.cm-content,[contenteditable="true"],textarea');
    if (!ce) throw new Error('找不到可编辑区域');
    ce.focus();
    if (ce.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ce, text);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      return 'textarea';
    }
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    return 'input-events';
  }

  // ---------- 通用：写入 Monaco（没有可用的模型 API 时才用） ----------
  const WRITE_FAILED = 'NBAC_WRITE_FAILED';
  async function writeMonaco(monacoEl, code) {
    // ① Monaco 自己的 API（能找到编辑器实例时最可靠）
    const mi = monacoInstance(monacoEl);
    if (mi) {
      mi.ed.setValue(code);
      if (H.codeMatches(mi.ed.getValue(), code)) return 'monaco-api(' + mi.via + ')';
    }
    const target = monacoEl.querySelector('.native-edit-context') || monacoEl.querySelector('textarea.inputarea') ||
      monacoEl.querySelector('textarea:not([readonly])');
    if (!target) throw new Error(WRITE_FAILED + ':找不到 Monaco 编辑器的输入区');
    const ok = () => H.codeMatches(monacoViewText(monacoEl), code);
    const selectAll = () => {
      if (!H.normCode(monacoViewText(monacoEl))) return;
      const mac = /Mac/.test(navigator.platform);
      key(target, 'a', { ctrlKey: !mac, metaKey: mac });
    };
    const methods = [
      ['paste', () => {
        // 粘贴不会触发自动补括号/自动缩进，是最准确的
        const dt = new DataTransfer();
        dt.setData('text/plain', code);
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      }],
      ['editcontext', () => {
        // VS Code / 新版 Monaco 用 EditContext 接收输入：发一次 textupdate 事件。
        // 让替换范围比当前选区多 1 个字符，Monaco 会走“输入法组合输入”分支，按原文插入，
        // 不会自动缩进/补括号（普通 type 分支会给多行文本加缩进）。新单元格是空的，多出的 1 个字符什么也删不掉。
        const ec = target.editContext;
        if (!ec || typeof TextUpdateEvent !== 'function') return;
        const from = ec.selectionStart, to = ec.selectionEnd + 1;
        ec.dispatchEvent(new TextUpdateEvent('textupdate', { text: code, updateRangeStart: from, updateRangeEnd: to,
          selectionStart: from + code.length, selectionEnd: from + code.length }));
      }],
      ['execCommand', () => { document.execCommand('insertText', false, code); }],
      ['beforeinput', () => {
        const o = { inputType: 'insertText', data: code, bubbles: true, cancelable: true, composed: true };
        if (target.dispatchEvent(new InputEvent('beforeinput', o))) target.dispatchEvent(new InputEvent('input', o));
      }]
    ];
    const tried = [];
    for (const [name, fn] of methods) {
      tried.push(name);
      target.focus();
      await sleep(30);
      selectAll();
      try { await fn(); } catch { /* 试下一个 */ }
      if (await waitFor(ok, 800, 60)) return 'monaco-' + name;
    }
    const left = H.normCode(monacoViewText(monacoEl));
    trace('monaco-write-failed', { tried, input: target.className || target.tagName, rendered: left.split('\n').length });
    throw new Error(WRITE_FAILED + ':没能把代码写进 Monaco 编辑器' + (left ? '（单元格里可能留下了不完整的内容，请先清空）' : ''));
  }

  // ---------- JupyterLab 模型定位：页面没暴露 window.jupyterapp 时，从 webpack 运行时里拿 @jupyterlab/notebook ----------
  // 做法：往 webpackChunk_* 数组里 push 一个探针 chunk，拿到 __webpack_require__；
  // 从 module federation 的共享作用域（__webpack_require__.S）或模块缓存（.c）里取出页面正在用的 @jupyterlab/notebook；
  // 给 Notebook.prototype.handleEvent 打个补丁记录 this（Notebook widget），再对 .jp-Notebook 派发一个无副作用的
  // lm-dragleave 事件触发它，就能从 DOM 节点找到 Notebook widget，直接操作单元格模型（setSource），不用往编辑器里“打字”。
  const labFinder = {
    req: null, mod: null, byNode: new WeakMap(), patched: false, info: {},
    webpackRequire() {
      if (this.req) return this.req;
      const keys = Object.keys(window).filter((k) => /^webpackChunk/.test(k));
      this.info.chunks = keys;
      for (const k of keys) {
        const ch = window[k];
        // 运行时还没加载时 push 是原生的 Array.prototype.push，不能往里塞东西
        if (!ch || typeof ch.push !== 'function' || ch.push === Array.prototype.push) continue;
        try { ch.push([['nbac-probe-' + Date.now() + '-' + Math.random()], {}, (r) => { this.req = r; }]); } catch (e) { this.info.pushError = String(e && e.message || e); }
        if (this.req) { this.info.chunk = k; break; }
      }
      return this.req;
    },
    async module() {
      if (this.mod) return this.mod;
      const req = this.webpackRequire();
      if (!req) return null;
      let m = null;
      try {
        for (const [scopeName, sc] of Object.entries(req.S || {})) {
          const entry = sc && sc['@jupyterlab/notebook'];
          this.info.shared = Object.keys(sc || {}).filter((k) => /^@jupyterlab\/(application|notebook|cells)$|monaco/.test(k))
            .map((k) => k + '@' + Object.keys(sc[k]).join('|')).slice(0, 10);
          if (!entry) continue;
          // 只取已经加载（页面正在用）的版本；取没加载的版本会得到另一份类，补丁不起作用
          const v = Object.keys(entry).find((x) => entry[x] && entry[x].loaded);
          if (!v) continue;
          const f = await entry[v].get();
          const mod = typeof f === 'function' ? f() : f;
          if (mod && mod.NotebookActions && mod.Notebook) { m = mod; this.info.via = 'share-scope:' + scopeName + ':' + v; break; }
        }
      } catch (e) { this.info.shareError = String(e && e.message || e); }
      if (!m && req.c) {
        for (const id of Object.keys(req.c)) {
          const e = req.c[id] && req.c[id].exports;
          if (e && e.NotebookActions && e.Notebook && e.NotebookPanel) { m = e; this.info.via = 'module-cache'; break; }
        }
      }
      if (m) { this.mod = m; this.modVia = this.info.via; this.patch(m); }
      return m;
    },
    patch(m) {
      if (this.patched) return;
      this.patched = true;
      const self = this;
      for (const C of [m.Notebook, m.StaticNotebook]) {
        if (!C || !C.prototype || !Object.prototype.hasOwnProperty.call(C.prototype, 'handleEvent')) continue;
        const orig = C.prototype.handleEvent;
        C.prototype.handleEvent = function () {
          try { if (this && this.node) self.byNode.set(this.node, this); } catch { /* ignore */ }
          return orig.apply(this, arguments);
        };
      }
    },
    async widgetFor(node) {
      if (!node || window.__nbacNoModel) return null;
      // ① document_start 时记下的监听器对象（不依赖 webpack）
      const early = window.__nbacEarly && !window.__nbacNoListenerHook ? window.__nbacEarly.listenerObjects.get(node) : null;
      if (early && 'activeCell' in early && early.widgets) {
        this.info.via = 'listener-hook';
        // 顺便尝试拿 NotebookActions（拿不到也能用模型直接插入）
        let mod = null;
        try { mod = await this.module(); } catch { /* ignore */ }
        this.info.via = 'listener-hook';
        this.info.actions = this.modVia || null;
        return { nb: early, mod };
      }
      // ② webpack 运行时
      let m = null;
      try { m = await this.module(); } catch (e) { this.info.error = String(e && e.message || e); }
      if (!m) return null;
      this.info.via = this.modVia;
      let w = this.byNode.get(node);
      for (const t of ['lm-dragleave', 'p-dragleave']) {
        if (w) break;
        try { node.dispatchEvent(new Event(t, { cancelable: true })); } catch { /* ignore */ }
        w = this.byNode.get(node);
      }
      return w && 'activeCell' in w && w.widgets ? { nb: w, mod: m } : null;
    }
  };

  // ---------- 适配器 1：JupyterLab（AI Studio BML Codelab、ModelScope/DSW、Kaggle 新编辑器若基于 JupyterLab） ----------
  const jupyterLab = {
    kind: 'jupyterlab',
    app() {
      const a = window.jupyterapp || window.jupyterlab;
      return a && a.commands && a.shell ? a : null;
    },
    panelWidget() {
      const a = this.app();
      if (!a) return null;
      const w = a.shell.currentWidget;
      return w && w.content && 'activeCell' in w.content ? w : null;
    },
    notebookNode() {
      const all = Array.from(document.querySelectorAll('.jp-Notebook'));
      // 当前标签页的 Notebook：可见的那个；多个可见时取最近获得焦点的
      const vis = all.filter(visible);
      const focused = vis.find((n) => n.contains(document.activeElement) || n.classList.contains('jp-mod-focused'));
      return focused || vis[0] || null;
    },
    detect() { return !!(this.notebookNode() || this.panelWidget()); },
    activeCellNode() {
      const nb = this.notebookNode();
      if (!nb) return null;
      return nb.querySelector('.jp-Cell.jp-mod-active') || nb.querySelector('.jp-Cell.jp-mod-selected') ||
        Array.from(nb.querySelectorAll('.jp-Cell')).pop() || null;
    },
    cellSource(cellModel) {
      const sm = cellModel.sharedModel;
      if (sm && sm.getSource) return sm.getSource();
      if (cellModel.value) return cellModel.value.text; // JupyterLab 3
      return '';
    },
    setCellSource(cellModel, text) {
      const sm = cellModel.sharedModel;
      if (sm && sm.setSource) return sm.setSource(text);
      if (cellModel.value) cellModel.value.text = text; // JupyterLab 3
    },
    async getActiveCellCode() {
      const w = this.panelWidget();
      if (w && w.content.activeCell) return this.cellSource(w.content.activeCell.model);
      const f = await labFinder.widgetFor(this.notebookNode());
      if (f && f.nb.activeCell) return this.cellSource(f.nb.activeCell.model);
      const cell = this.activeCellNode();
      return cell ? getEditorText(cell.querySelector('.jp-InputArea-editor') || cell) : '';
    },
    getLastErrorOutput() {
      const nb = this.notebookNode();
      if (!nb) return '';
      const sel = '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stderr"], .jp-RenderedText[data-mime-type="application/vnd.jupyter.stderr"]';
      const active = this.activeCellNode();
      let nodes = active ? Array.from(active.querySelectorAll(sel)) : [];
      if (!nodes.length) nodes = Array.from(nb.querySelectorAll(sel));
      if (!nodes.length) return '';
      const cell = nodes[nodes.length - 1].closest('.jp-Cell');
      const inCell = cell ? Array.from(cell.querySelectorAll(sel)) : [nodes[nodes.length - 1]];
      return inCell.map((n) => n.innerText).join('\n').trim();
    },
    toolbarButton(command) {
      const nb = this.notebookNode();
      const panel = nb && nb.closest('.jp-NotebookPanel');
      const scope = panel || document;
      // 优先可见的按钮（Notebook 顶部工具栏 > 当前单元格的悬浮工具栏）；
      // 平台用 CSS 把工具栏藏起来时，隐藏的按钮依然在 DOM 里、React 事件依然有效，也可以用
      const btns = Array.from(scope.querySelectorAll(`[data-command="${command}"]`))
        .filter((b) => !b.closest('.jp-Toolbar-responsive-popup'));
      const rank = (b) => (visible(b) ? 0 : 2) + (b.closest('.jp-NotebookPanel-toolbar') ? 0 : 1);
      btns.sort((a, b) => rank(a) - rank(b));
      return btns[0] || null;
    },
    async insertCellBelow(code) {
      steps = [];
      const w = this.panelWidget();
      const a = this.app();
      if (w && a) {
        await a.commands.execute('notebook:insert-cell-below');
        try { await a.commands.execute('notebook:change-cell-to-code'); } catch { /* ignore */ }
        const cell = w.content.activeCell;
        this.setCellSource(cell.model, code);
        if (H.codeMatches(this.cellSource(cell.model), code)) return { inserted: true, via: 'jupyterlab-commands' };
        trace('commands-setSource-mismatch');
        const how = await setEditorText(cell.node.querySelector('.jp-InputArea-editor') || cell.node, code);
        return { inserted: true, via: 'jupyterlab-commands+' + how };
      }
      // 没暴露 app 时：从 webpack 运行时找到 Notebook widget，直接改单元格模型
      const f = await labFinder.widgetFor(this.notebookNode());
      trace('lab-model', { found: !!f, info: labFinder.info });
      if (f) {
        const { nb, mod } = f;
        const n0 = nb.widgets.length;
        if (mod && mod.NotebookActions) {
          mod.NotebookActions.insertBelow(nb);
          if (nb.activeCell && nb.activeCell.model.type !== 'code') { try { mod.NotebookActions.changeCellType(nb, 'code'); } catch { /* ignore */ } }
        } else {
          // 没有 NotebookActions：直接往 Notebook 模型里插一个代码单元格
          const idx = nb.activeCellIndex;
          const sm = nb.model && nb.model.sharedModel;
          if (sm && sm.insertCell) sm.insertCell(idx + 1, { cell_type: 'code', source: '' });
          else if (nb.model && nb.model.cells && nb.model.contentFactory) nb.model.cells.insert(idx + 1, nb.model.contentFactory.createCodeCell({}));
          nb.activeCellIndex = idx + 1;
        }
        const cell = nb.activeCell;
        if (cell && nb.widgets.length > n0) {
          this.setCellSource(cell.model, code);
          try { cell.node.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
          if (H.codeMatches(this.cellSource(cell.model), code)) return { inserted: true, via: 'jupyterlab-model(' + (labFinder.info.via || '') + ')' };
          trace('model-setSource-mismatch');
          const how = await setEditorText(cell.node.querySelector('.jp-InputArea-editor') || cell.node, code);
          return { inserted: true, via: 'jupyterlab-model+' + how };
        }
        trace('model-insert-failed', { before: n0, after: nb.widgets.length });
      }
      // DOM 方式
      const nb = this.notebookNode();
      if (!nb) throw new Error('未找到 Notebook');
      const before = nb.querySelectorAll('.jp-Cell').length;
      const oldActive = this.activeCellNode();
      const btn = this.toolbarButton('notebook:insert-cell-below');
      const grew = (ms) => waitFor(() => nb.querySelectorAll('.jp-Cell').length > before, ms);
      let via = '';
      let ok = false;
      if (btn) {
        press(btn); via = 'toolbar-button';
        ok = await grew(2000);
      }
      if (!ok && document.hasFocus()) {
        // 命令模式下按 B。JupyterLab 的这个快捷键要求目标元素处于 :focus，
        // 所以只有页面（frame）本身有焦点时才有效
        const ed = oldActive && oldActive.querySelector('.cm-content, .monaco-editor textarea, .monaco-editor .native-edit-context');
        if (nb.classList.contains('jp-mod-editMode') && ed) key(ed, 'Escape');
        await sleep(150);
        let t = nb.contains(document.activeElement) && !document.activeElement.matches('.cm-content, textarea') ? document.activeElement : null;
        if (!t) {
          t = oldActive || nb;
          if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
          t.focus();
        }
        key(t, 'b');
        via = 'keyboard';
        ok = await grew(1500);
      }
      if (!ok) {
        // 最后兜底：Notebook 底部的“点击添加单元格”区域（会加在末尾）
        const footer = nb.querySelector('.jp-Notebook-footer');
        if (footer) { press(footer); via = 'notebook-footer(末尾)'; ok = await grew(2000); }
      }
      if (!ok) throw new Error('插入新单元格失败（工具栏按钮、快捷键和底部“添加单元格”都无效）');
      const cell = await waitFor(() => {
        const c = this.activeCellNode();
        return c && c !== oldActive ? c : null;
      });
      if (!cell) throw new Error('找不到新插入的单元格');
      cell.scrollIntoView({ block: 'center' });
      const ed = await waitFor(() => cell.querySelector('.cm-content, .CodeMirror, .monaco-editor textarea, .monaco-editor .native-edit-context, textarea'));
      if (!ed) throw new Error('新单元格的编辑器没有加载');
      const how = await setEditorText(cell.querySelector('.jp-InputArea-editor') || cell, code);
      return { inserted: true, via: via + '+' + how };
    },
    async runCell() {
      const w = this.panelWidget();
      const a = this.app();
      if (w && a) {
        await a.commands.execute('notebook:run-cell');
        return { ran: true, via: 'jupyterlab-commands' };
      }
      const f = await labFinder.widgetFor(this.notebookNode());
      if (f && f.mod && f.mod.NotebookActions && f.nb.activeCell) {
        const panel = f.nb.parent;
        // 不等运行结束（可能很久）；出错会显示在单元格输出里
        Promise.resolve(f.mod.NotebookActions.run(f.nb, panel && panel.sessionContext)).catch(() => {});
        return { ran: true, via: 'jupyterlab-model' };
      }
      const btn = this.toolbarButton('notebook:run-cell-and-select-next') || this.toolbarButton('notebook:run-cell');
      if (btn) { press(btn); return { ran: true, via: 'toolbar-button' }; }
      const cell = this.activeCellNode();
      const target = cell && (cell.querySelector('.cm-content, .monaco-editor textarea, .monaco-editor .native-edit-context, .CodeMirror textarea') || cell);
      if (target && target.focus) target.focus();
      key(target, 'Enter', { shiftKey: true });
      return { ran: true, via: 'keyboard' };
    }
  };

  // ---------- 适配器 2：经典 Jupyter Notebook（AI Studio 经典版等） ----------
  const classicNotebook = {
    kind: 'classic-notebook',
    nb() { return window.Jupyter && window.Jupyter.notebook && window.Jupyter.notebook.get_selected_cell ? window.Jupyter.notebook : null; },
    detect() { return !!this.nb(); },
    getActiveCellCode() { const c = this.nb().get_selected_cell(); return c ? c.get_text() : ''; },
    getLastErrorOutput() {
      const nodes = document.querySelectorAll('.output_stderr, .output_error');
      return nodes.length ? nodes[nodes.length - 1].innerText.trim() : '';
    },
    async insertCellBelow(code) {
      const nb = this.nb();
      const cell = nb.insert_cell_below('code');
      cell.set_text(code);
      nb.select(nb.find_cell_index(cell));
      return { inserted: true, via: 'Jupyter.notebook' };
    },
    async runCell() { this.nb().get_selected_cell().execute(); return { ran: true, via: 'Jupyter.notebook' }; }
  };

  // ---------- 适配器 3（兜底）：Kaggle 旧式/非 JupyterLab 编辑器 ----------
  // 实测（2026-11）：Kaggle 编辑器的单元格是嵌在 iframe 里的 JupyterLab 4
  // （kkb-production.jupyter-proxy.kaggle.net，iframe name="notebook-editor-cells"），
  // 那个 frame 里会走上面的 JupyterLab 适配器；顶层 www.kaggle.com 没有单元格，会回报“不是 Notebook”。
  // 下面这个基于 DOM 的适配器只在页面里没有 JupyterLab、但有编辑器时兜底。
  // 假设（无法登录验证）：
  //  - 每个代码单元格包含一个 CodeMirror（.cm-editor 或 .CodeMirror）或 Monaco 编辑器；
  //  - 有“+ Code”/“Add code cell”按钮，或支持 Jupyter 风格的 Esc → B 快捷键；
  //  - 运行：Shift+Enter，或单元格内 aria-label/title 含 “Run” 的按钮；
  //  - 报错输出包含 “Traceback” 或带 error/stderr 类名。
  // 如果 Kaggle 页面本身是 JupyterLab（存在 .jp-Notebook），优先走 JupyterLab 适配器。
  let lastFocusedEditor = null;
  document.addEventListener('focusin', (e) => {
    const ed = e.target && e.target.closest && e.target.closest('.cm-editor, .CodeMirror, .monaco-editor');
    if (ed) lastFocusedEditor = ed;
  }, true);

  const kaggle = {
    kind: 'kaggle-dom',
    editors() {
      return Array.from(document.querySelectorAll('.cm-editor, .CodeMirror, .monaco-editor')).filter(visible)
        .filter((e) => !e.parentElement.closest('.cm-editor, .CodeMirror, .monaco-editor'));
    },
    detect() {
      if (!/kaggle/.test(location.hostname) && !window.__nbacForceKaggle) return false;
      return this.editors().length > 0;
    },
    activeEditor() {
      const eds = this.editors();
      const byFocus = eds.find((e) => e.contains(document.activeElement));
      if (byFocus) return byFocus;
      if (lastFocusedEditor && eds.includes(lastFocusedEditor)) return lastFocusedEditor;
      return eds[eds.length - 1] || null;
    },
    cellOf(ed) {
      return ed.closest('[data-testid*="cell" i], [class*="cell" i]:not([class*="cm-"])') || ed.parentElement;
    },
    getActiveCellCode() { const ed = this.activeEditor(); return ed ? getEditorText(ed) : ''; },
    getLastErrorOutput() {
      const cand = Array.from(document.querySelectorAll(
        '.output_error, .output_stderr, [class*="stderr" i], [class*="error-output" i], [data-mime-type="application/vnd.jupyter.stderr"], pre'
      )).filter((n) => /Traceback|Error|Exception/.test(n.innerText || ''));
      // 只取最外层节点，避免重复
      const outer = cand.filter((n) => !cand.some((o) => o !== n && o.contains(n)));
      return outer.length ? outer[outer.length - 1].innerText.trim() : '';
    },
    findButton(regexes, scope = document) {
      const btns = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(visible);
      for (const re of regexes) {
        const b = btns.find((x) => re.test((x.getAttribute('aria-label') || '') + '|' + (x.title || '') + '|' + (x.textContent || '').trim()));
        if (b) return b;
      }
      return null;
    },
    async insertCellBelow(code) {
      const before = this.editors();
      const active = this.activeEditor();
      const cell = active && this.cellOf(active);
      // 优先：单元格自带的“在下方添加代码单元格”按钮，其次全局“+ Code”按钮
      let btn = (cell && this.findButton([/add code cell below|insert code cell below|在下方.*代码/i], cell)) ||
        this.findButton([/^\s*\|?\s*\+\s*code\s*$/i, /\|\s*\+?\s*code\s*$/i, /add code cell|insert code cell|添加代码单元格/i]);
      let via;
      if (btn) { btn.click(); via = 'button'; } else {
        const t = (active && (active.querySelector('.cm-content,textarea') || active)) || document.body;
        key(t, 'Escape');
        key(document.activeElement || document.body, 'b');
        via = 'keyboard';
      }
      const newEd = await waitFor(() => this.editors().find((e) => !before.includes(e)));
      if (!newEd) throw new Error('插入新单元格失败：没有找到“+ Code”按钮，Esc+B 也无效');
      newEd.scrollIntoView({ block: 'center' });
      const how = await setEditorText(newEd, code);
      lastFocusedEditor = newEd;
      return { inserted: true, via: via + '+' + how };
    },
    async runCell() {
      const ed = this.activeEditor();
      if (!ed) throw new Error('没有可运行的单元格');
      const cell = this.cellOf(ed);
      const btn = cell && this.findButton([/run (current )?cell|^run$|运行/i], cell);
      if (btn) { btn.click(); return { ran: true, via: 'button' }; }
      const t = ed.querySelector('.cm-content, textarea, [contenteditable="true"]') || ed;
      if (t.focus) t.focus();
      key(t, 'Enter', { shiftKey: true });
      return { ran: true, via: 'keyboard' };
    }
  };

  // ---------- 适配器 4：VS Code 原生 Notebook 编辑器（ModelScope 免费 CPU 实例的 Code Editor） ----------
  // 结构（2026-11 对照真实 ModelScope 页面抓取）：外层 modelscope.cn/code/workspace 页面
  // 同源嵌 iframe[title="notebook-ide"] → /notebook/main.html（VS Code web 工作台）。
  // .notebook-editor > .notebook-toolbar-container（a[aria-label="Add Code Cell"] 等）+ .cell-list-container >
  // div.monaco-list[aria-label="Notebook"] > .monaco-list-row.code-cell-row[data-index][aria-setsize]（当前单元格有 .focused/.selected）。
  // 单元格编辑器是 Monaco，用 EditContext（.native-edit-context），没有全局 monaco；输出渲染在跨域 webview 里，通常读不到文字。
  const vscodeNotebook = {
    kind: 'vscode-notebook',
    editor() {
      const eds = Array.from(document.querySelectorAll('.notebook-editor'))
        .filter((e) => e.querySelector('.cell-list-container .monaco-list'));
      const vis = eds.filter(visible);
      const pool = vis.length ? vis : eds;
      return pool.find((e) => e.contains(document.activeElement)) || pool[pool.length - 1] || null;
    },
    list() { const e = this.editor(); return e && e.querySelector('.cell-list-container .monaco-list'); },
    detect() { return !!this.list(); },
    rows() {
      const l = this.list();
      if (!l) return [];
      return Array.from(l.querySelectorAll('.monaco-list-row.code-cell-row, .monaco-list-row.markdown-cell-row'))
        .sort((a, b) => (+a.dataset.index || 0) - (+b.dataset.index || 0));
    },
    // 总单元格数：列表是虚拟滚动的，屏幕外的行不在 DOM 里，用 aria-setsize
    total() {
      const rows = this.rows();
      const n = rows.reduce((m, r) => Math.max(m, +r.getAttribute('aria-setsize') || 0), 0);
      return Math.max(n, rows.length);
    },
    activeRow() {
      const l = this.list();
      if (!l) return null;
      const rows = this.rows();
      const byFocus = rows.find((r) => r.contains(document.activeElement));
      const id = l.getAttribute('aria-activedescendant');
      return byFocus || rows.find((r) => r.classList.contains('focused')) || rows.find((r) => r.classList.contains('selected')) ||
        (id && rows.find((r) => r.id === id)) || rows[rows.length - 1] || null;
    },
    monacoOf(row) { return row && (row.querySelector('.cell-editor-container .monaco-editor') || row.querySelector('.monaco-editor')); },
    getActiveCellCode() { const m = this.monacoOf(this.activeRow()); return m ? monacoViewText(m) : ''; },
    // 输出在跨域 webview 里时读不到；能读到的（DOM 里的文字、通知）就读
    outputText(row) {
      const out = row && row.querySelector('.output');
      return out ? (out.innerText || '').trim() : '';
    },
    getLastErrorOutput() {
      const row = this.activeRow();
      const t = this.outputText(row);
      if (/Traceback|Error|Exception|ipykernel/i.test(t)) return t;
      return '';
    },
    outputUnreadable() {
      const row = this.activeRow();
      if (!row) return false;
      const hasOut = row.querySelector('.output') && !this.outputText(row);
      return !!(hasOut || this.editor().querySelector('iframe.webview'));
    },
    kernelHint() {
      const ed = this.editor();
      if (!ed) return '';
      const btn = ed.querySelector('a.codicon-notebook-kernel-select');
      const lab = btn && btn.parentElement && btn.parentElement.querySelector('.kernel-label');
      return H.vscodeKernelHint({ hasButton: !!btn, label: btn ? (btn.getAttribute('aria-label') || '') + ' ' + (lab ? lab.textContent : '') : '', pageText: document.body.innerText || '' });
    },
    uriOf(row) { const m = this.monacoOf(row); return (m && m.getAttribute('data-uri')) || ''; },
    snapshot() { return { total: this.total(), uris: new Set(this.rows().map((r) => this.uriOf(r)).filter(Boolean)) }; },
    grew(snap) {
      if (this.total() > snap.total) return true;
      // 虚拟列表里总数没变化时：当前行是一个没见过的（新）单元格，且是空的
      const a = this.activeRow();
      const u = a && this.uriOf(a);
      return !!(u && !snap.uris.has(u) && !H.normCode(monacoViewText(this.monacoOf(a))));
    },
    // 有些工具栏（单元格下方的 + Code）只在鼠标悬停时才渲染/显示：先模拟鼠标移上去
    hover(el) {
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const o = { cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + Math.max(1, r.height - 4), view: window };
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
        const E = t.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        try { el.dispatchEvent(new E(t, { ...o, bubbles: !/enter/.test(t) })); } catch { /* ignore */ }
      }
    },
    // VS Code 的动作栏有的听 click，有的听 mousedown / pointerdown：发完整的一套
    pressFull(el) {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
      const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new P('pointerdown', { ...o, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new P('pointerup', { ...o, buttons: 0, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
    },
    labelsOf(el) {
      return [el.getAttribute('aria-label') || '', el.getAttribute('title') || '', (el.textContent || '').replace(/\s+/g, ' ').trim()];
    },
    // 找“添加代码单元格”按钮：aria-label / title / 文字匹配（可能带快捷键后缀、可能是中文界面），按位置排优先级
    addCodeButtons(row) {
      const ed = this.editor();
      const RE = /add code cell|insert code cell|new code cell|code cell below|^\+?\s*code$|添加代码单元格|插入代码单元格|代码单元格|^\+?\s*代码$/i;
      const BAD = /markdown|正文|文本|delete|删除|execute|运行|split|拆分|run all|clear/i;
      const scopes = [
        ['cell-toolbar', row && row.querySelector('.cell-bottom-toolbar-container')],
        ['cell-row', row],
        ['notebook-toolbar', ed && ed.querySelector('.notebook-toolbar-container')],
        ['top-toolbar', ed && ed.querySelector('.cell-list-top-cell-toolbar-container')],
        ['empty-notebook', ed && ed.querySelector('.notebook-empty-placeholder, .emptyNotebook, .notebook-empty')],
        ['notebook-editor', ed],
        ['action-bars', document.body]
      ];
      const seen = new Set();
      const out = [];
      for (const [where, sc] of scopes) {
        if (!sc) continue;
        for (const el of sc.querySelectorAll('a, button, [role="button"], .action-label, .monaco-button')) {
          const [aria, title, text] = this.labelsOf(el);
          const hit = RE.test(aria) || RE.test(title.replace(/\s*\(.*\)\s*$/, '')) || (text.length <= 24 && RE.test(text));
          if (!hit || [aria, title, text].some((x) => BAD.test(x))) continue;
          // 别的单元格下面的 + Code 会插到别处：只用当前行的
          const otherRow = el.closest('.monaco-list-row');
          if (otherRow && row && otherRow !== row) continue;
          if (where === 'action-bars' && !el.closest('.monaco-action-bar, .monaco-toolbar, .notebook-editor')) continue;
          const item = el.closest('.action-item');
          const clickable = (item && item.querySelector('a.action-label, .action-label')) || el.closest('a, button, [role="button"]') || el;
          if (seen.has(clickable)) continue;
          seen.add(clickable);
          out.push([where, clickable]);
        }
      }
      return out;
    },
    describe(el) {
      const [aria, title, text] = this.labelsOf(el);
      return { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 80), aria: aria.slice(0, 60), title: title.slice(0, 60), text: text.slice(0, 30), visible: visible(el) };
    },
    async insertCellBelow(code) {
      steps = [];
      const ed = this.editor();
      if (!ed) throw new Error('未找到 Notebook 编辑器');
      const old = this.activeRow();
      const oldIndex = old ? +old.dataset.index : -1;
      const snap = this.snapshot();
      trace('vscode-insert', { total: snap.total, rows: this.rows().length, activeIndex: oldIndex });
      if (old) {
        this.hover(old);
        this.hover(old.querySelector('.cell-bottom-toolbar-container'));
        await sleep(120);
      }
      let via = '';
      const cands = this.addCodeButtons(old);
      trace('add-code-candidates', { n: cands.length, list: cands.slice(0, 6).map(([w, b]) => ({ where: w, ...this.describe(b) })) });
      for (const [where, btn] of cands) {
        if (!btn.isConnected) continue;
        this.hover(btn);
        this.pressFull(btn);
        // 动作可能是异步的：多等一会儿再判断，避免重复插入
        if (await waitFor(() => this.grew(snap), 3000)) { via = where; break; }
        trace('no-new-cell-after-click', { where });
      }
      if (!via) {
        // 快捷键兜底：命令模式下按 B（VS Code 可能不理会合成的键盘事件）
        const list = this.list();
        if (list) {
          const act = document.activeElement;
          const edInput = act && act.closest && act.closest('.monaco-editor');
          if (edInput) key(act, 'Escape');
          list.focus();
          await sleep(80);
          key(list.contains(document.activeElement) ? document.activeElement : list, 'b');
          if (await waitFor(() => this.grew(snap), 2000)) via = 'keyboard(B)';
          else trace('keyboard-b-no-effect');
        }
      }
      let row = null;
      if (via) {
        row = await waitFor(() => {
          const a = this.activeRow();
          if (a && (+a.dataset.index !== oldIndex || (this.uriOf(a) && !snap.uris.has(this.uriOf(a)))) && this.monacoOf(a)) return a;
          return this.rows().find((r) => +r.dataset.index === oldIndex + 1 && this.monacoOf(r)) || null;
        }, 3000);
        if (!row) trace('new-row-not-found');
        else if (oldIndex >= 0 && +row.dataset.index !== oldIndex + 1) via += '(末尾)';
      }
      if (!row) {
        // 新建单元格失败：当前选中的单元格是空的，就直接写进去
        const a = old || this.activeRow();
        const am = a && this.monacoOf(a);
        if (!via && am && !H.normCode(monacoViewText(am))) { row = a; via = 'current-empty-cell'; }
        else {
          throw new Error('插入新单元格失败：没有找到能用的“+ Code / Add Code Cell”按钮，按 B 也没有反应。' +
            '可以先在 Notebook 里点一下一个空单元格再点“插入”，代码会写进这个空单元格；或者点“+ → 复制诊断信息”发给开发者');
        }
      }
      row.scrollIntoView({ block: 'center' });
      const m = await waitFor(() => { const x = this.monacoOf(row); return x && x.querySelector('.native-edit-context, textarea') ? x : null; });
      if (!m) throw new Error(WRITE_FAILED + ':新单元格的编辑器没有加载');
      const how = await writeMonaco(m, code);
      return { inserted: true, via: via + '+' + how, notice: this.kernelHint() };
    },
    async runCell() {
      const row = this.activeRow();
      if (!row) throw new Error('没有可运行的单元格');
      this.hover(row);
      await sleep(60);
      const RUN = /^(execute cell|run cell|执行单元格|运行单元格)/i;
      const btn = row.querySelector('.run-button-container a.codicon-notebook-execute, .run-button-container a[aria-label^="Execute Cell"]') ||
        Array.from(row.querySelectorAll('a, button, [role="button"]')).find((b) => this.labelsOf(b).slice(0, 2).some((x) => RUN.test(x)));
      if (btn) {
        this.pressFull(btn);
        await sleep(1500);
        return { ran: true, via: 'execute-button', notice: this.kernelHint() };
      }
      // 兜底：编辑器里按 Ctrl+Enter（VS Code 的“运行单元格”快捷键）
      const m = this.monacoOf(row);
      const input = m && m.querySelector('.native-edit-context, textarea');
      if (!input) throw new Error('找不到这个单元格的运行按钮（Execute Cell）');
      input.focus();
      const mac = /Mac/.test(navigator.platform);
      key(input, 'Enter', { ctrlKey: !mac, metaKey: mac });
      await sleep(1500);
      return { ran: true, via: 'keyboard(Ctrl+Enter)', notice: this.kernelHint() };
    }
  };

  function platformName() {
    if (window.__nbacForceKaggle) return 'Kaggle';
    return H.platformFromHost(location.hostname);
  }


  function pickAdapter() {
    if (jupyterLab.detect()) return jupyterLab;
    if (classicNotebook.detect()) return classicNotebook;
    if (vscodeNotebook.detect()) return vscodeNotebook;
    if (kaggle.detect()) return kaggle;
    return null;
  }

  // 诊断信息：只收集结构（选择器数量、全局变量、版本、按钮标签），不收集代码、输出和 Key
  async function diagnose() {
    const sels = ['.jp-LabShell', '.jp-Notebook', '.jp-Cell', '.jp-mod-active', '[data-command="notebook:insert-cell-below"]',
      '[data-command="notebook:run-cell-and-select-next"]', '.jp-Notebook-footer', '.monaco-editor', 'textarea.inputarea',
      '.native-edit-context', 'textarea.ime-text-area', '.view-lines', '.cm-editor', '.CodeMirror', '.monaco-workbench',
      '.notebook-editor', '.cell-list-container .monaco-list', '.code-cell-row', '.monaco-list-row.focused', '.notebook-toolbar-container',
      '.cell-bottom-toolbar-container', '.cell-list-top-cell-toolbar-container', '.run-button-container', 'a.codicon-notebook-kernel-select', 'iframe'];
    const counts = {};
    for (const q of sels) { try { counts[q] = document.querySelectorAll(q).length; } catch { counts[q] = -1; } }
    const req = window.require;
    const globals = {
      jupyterapp: !!window.jupyterapp, jupyterlab: !!window.jupyterlab, Jupyter: !!window.Jupyter, monaco: !!window.monaco,
      require: typeof req, requireDefined: !!(req && req.defined), amdMonaco: !!(req && req.defined && (() => { try { return req.defined('vs/editor/editor.main'); } catch { return false; } })()),
      webpackChunks: Object.keys(window).filter((k) => /^webpackChunk/.test(k)),
      _JUPYTERLAB: window._JUPYTERLAB ? Object.keys(window._JUPYTERLAB).slice(0, 20) : null,
      EditContext: typeof window.EditContext
    };
    const versions = {};
    try {
      const cfg = document.getElementById('jupyter-config-data');
      if (cfg) { const c = JSON.parse(cfg.textContent); versions.jupyterlab = c.appVersion || null; versions.appName = c.appName || null; versions.locale = c.locale || null; }
    } catch { /* ignore */ }
    const a = pickAdapter();
    let lab = null;
    if (a === jupyterLab && !jupyterLab.panelWidget()) {
      const f = await labFinder.widgetFor(jupyterLab.notebookNode());
      lab = { modelFound: !!f, ...labFinder.info };
    }
    const out = { url: location.origin + location.pathname, top: window.top === window, title: document.title.slice(0, 60), lang: document.documentElement.lang || '',
      platform: platformName(), adapter: a ? a.kind : null, counts, globals, versions, lab, lastError, lastSteps: steps.slice(-20) };
    if (a === vscodeNotebook || document.querySelector('.notebook-editor')) {
      const scope = Array.from(document.querySelectorAll('.notebook-editor .monaco-action-bar a, .notebook-editor .monaco-action-bar [role="button"], .notebook-toolbar-container a, .cell-bottom-toolbar-container a, .cell-list-top-cell-toolbar-container a, .notebook-editor button'));
      out.actions = Array.from(new Set(scope)).slice(0, 60).map((el) => vscodeNotebook.describe(el));
      const row = vscodeNotebook.activeRow();
      out.vscode = { total: vscodeNotebook.total(), rows: vscodeNotebook.rows().length, activeIndex: row ? row.dataset.index : null,
        activeHasUri: !!(row && vscodeNotebook.uriOf(row)), kernel: (document.querySelector('a.codicon-notebook-kernel-select') || { getAttribute: () => null }).getAttribute('aria-label') };
    }
    if (a === jupyterLab) {
      out.commands = Array.from(new Set(Array.from(document.querySelectorAll('[data-command]')).map((e) => e.getAttribute('data-command')))).slice(0, 40);
    }
    return out;
  }

  const handlers = {
    diagnose,
    async detect() {
      const a = pickAdapter();
      if (!a) {
        const r = { detected: false, platform: platformName() };
        // 飞桨 AI Studio 外层的项目编辑器（/project/edit/…）不是 JupyterLab，提示进入 BML Codelab
        if (r.platform === '飞桨 AI Studio' && window.top === window && /\/project\/(edit|detail)\//.test(location.pathname)) {
          r.hint = '这是 AI Studio 外层的项目编辑器，暂不支持。请点击「专业开发」打开 BML Codelab 后使用';
        }
        // JupyterLab 界面已经加载，但当前标签页不是 Notebook（启动器、文件浏览器、终端等）
        if (!r.hint && (document.getElementById('jp-main-dock-panel') || document.querySelector('.jp-LabShell'))) {
          r.hint = (r.platform === 'Jupyter' ? 'JupyterLab' : r.platform) + ' 已打开，但当前没有打开 Notebook：请在左侧文件浏览器里双击一个 .ipynb，或在启动器里新建 Notebook（Python 3）';
        }
        if (r.platform === 'ModelScope' && document.querySelector('.monaco-workbench')) {
          r.hint = 'ModelScope Code Editor 里还没打开 Notebook：请打开或新建一个 .ipynb 文件（File → New File… → Jupyter Notebook）';
        } else if (r.platform === 'ModelScope' && window.top === window && /^\/my\/mynotebook/.test(location.pathname)) {
          r.hint = '请先启动 Notebook 实例，再点「查看 / View」打开 Code Editor';
        }
        return r;
      }
      const nb = a === jupyterLab ? jupyterLab.notebookNode() : null;
      const cellCount = nb ? nb.querySelectorAll('.jp-Cell').length : (a === kaggle ? kaggle.editors().length : (a === vscodeNotebook ? vscodeNotebook.total() : 0));
      const r = { detected: true, platform: platformName(), kind: a.kind, cellCount, viaApp: a === jupyterLab && !!jupyterLab.panelWidget() };
      if (a === jupyterLab && !r.viaApp) r.viaModel = !!(await labFinder.widgetFor(nb));
      if (a === vscodeNotebook) r.notice = vscodeNotebook.kernelHint();
      return r;
    },
    async getContext() {
      const a = pickAdapter();
      if (!a) throw new Error('当前页面没有检测到 Notebook');
      const r = { platform: platformName(), kind: a.kind, cellCode: await a.getActiveCellCode(), errorOutput: a.getLastErrorOutput() };
      if (a === vscodeNotebook) {
        r.outputUnreadable = !r.errorOutput && vscodeNotebook.outputUnreadable();
        r.notice = vscodeNotebook.kernelHint();
      }
      return r;
    },
    getActiveCellCode() { const a = pickAdapter(); if (!a) throw new Error('未检测到 Notebook'); return a.getActiveCellCode(); },
    getLastErrorOutput() { const a = pickAdapter(); if (!a) throw new Error('未检测到 Notebook'); return a.getLastErrorOutput(); },
    async insertCellBelow({ code }) {
      const a = pickAdapter(); if (!a) throw new Error('未检测到 Notebook');
      if (typeof code !== 'string') throw new Error('code 必须是字符串');
      return a.insertCellBelow(code);
    },
    async runCell() { const a = pickAdapter(); if (!a) throw new Error('未检测到 Notebook'); return a.runCell(); }
  };

  document.addEventListener('nbac-request', async (ev) => {
    let req;
    try { req = JSON.parse(ev.detail); } catch { return; }
    let resp;
    try {
      const fn = handlers[req.action];
      if (!fn) throw new Error('未知操作: ' + req.action);
      resp = { id: req.id, ok: true, result: await fn(req.args || {}) };
    } catch (e) {
      resp = { id: req.id, ok: false, error: String(e && e.message || e) };
      if (req.action !== 'diagnose') {
        lastError = { action: req.action, message: String(e && e.message || e).slice(0, 300),
          stack: String(e && e.stack || '').split('\n').slice(0, 6).join('\n').slice(0, 800), steps: steps.slice(-20), at: new Date().toISOString() };
      }
    }
    document.dispatchEvent(new CustomEvent('nbac-response', { detail: JSON.stringify(resp) }));
  });
})();
