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

  function monacoInstance(monacoEl) {
    const m = window.monaco;
    if (!m || !m.editor || !m.editor.getEditors) return null;
    return m.editor.getEditors().find((e) => { const d = e.getDomNode && e.getDomNode(); return d && (d === monacoEl || monacoEl.contains(d) || d.contains(monacoEl)); }) || null;
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
      const ed = monacoInstance(monacoEl);
      if (ed) return ed.getValue();
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
    if (monacoEl) {
      const ed = monacoInstance(monacoEl);
      if (ed) { ed.setValue(text); return 'monaco'; }
      // 没有全局 monaco：对 Monaco 的隐藏 textarea 发一个“粘贴”事件（粘贴不会触发自动补括号）
      const ta = monacoEl.querySelector('textarea.inputarea, textarea, .native-edit-context');
      if (!ta) throw new Error('找不到 Monaco 编辑器的输入区');
      ta.focus();
      if (getEditorText(monacoEl).trim()) {
        key(ta, 'a', { ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform) });
      }
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(120);
      const got = getEditorText(monacoEl);
      if (got.trim().split('\n')[0] !== text.trim().split('\n')[0]) throw new Error('写入 Monaco 编辑器失败');
      return 'monaco-paste';
    }
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
    getActiveCellCode() {
      const w = this.panelWidget();
      if (w && w.content.activeCell) return this.cellSource(w.content.activeCell.model);
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
      const w = this.panelWidget();
      const a = this.app();
      if (w && a) {
        await a.commands.execute('notebook:insert-cell-below');
        try { await a.commands.execute('notebook:change-cell-to-code'); } catch { /* ignore */ }
        const cell = w.content.activeCell;
        this.setCellSource(cell.model, code);
        return { inserted: true, via: 'jupyterlab-commands' };
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
  const WRITE_FAILED = 'NBAC_WRITE_FAILED';
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
    button(scope, label) {
      if (!scope) return null;
      const all = Array.from(scope.querySelectorAll(`a.action-label[aria-label="${label}"], [role="button"][aria-label="${label}"]`));
      return all.find(visible) || all[0] || null;
    },
    async writeMonaco(monacoEl, code) {
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
      for (const [name, fn] of methods) {
        target.focus();
        await sleep(30);
        selectAll();
        try { await fn(); } catch { /* 试下一个 */ }
        if (await waitFor(ok, 800, 60)) return 'monaco-' + name;
      }
      const left = H.normCode(monacoViewText(monacoEl));
      throw new Error(WRITE_FAILED + ':没能把代码写进 Monaco 编辑器' + (left ? '（单元格里可能留下了不完整的内容，请先清空）' : ''));
    },
    async insertCellBelow(code) {
      const ed = this.editor();
      if (!ed) throw new Error('未找到 Notebook 编辑器');
      const before = this.total();
      const old = this.activeRow();
      const oldIndex = old ? +old.dataset.index : -1;
      // 优先：当前单元格下方的“+ Code”（插在它后面）；其次 Notebook 顶部工具栏的“+ Code”（VS Code 会插在当前单元格后面）
      const cands = [];
      if (old) cands.push(['cell-toolbar', this.button(old.querySelector('.cell-bottom-toolbar-container'), 'Add Code Cell')]);
      cands.push(['notebook-toolbar', this.button(ed.querySelector('.notebook-toolbar-container'), 'Add Code Cell')]);
      if (!old) cands.push(['top-toolbar', this.button(ed.querySelector('.cell-list-top-cell-toolbar-container'), 'Add Code Cell')]);
      let via = '';
      for (const [name, btn] of cands) {
        if (!btn) continue;
        press(btn); via = name;
        if (await waitFor(() => this.total() > before, 2500)) break;
        via = '';
      }
      if (!via) throw new Error('插入新单元格失败：没有找到可用的“+ Code / Add Code Cell”按钮');
      const row = await waitFor(() => {
        const a = this.activeRow();
        if (a && +a.dataset.index !== oldIndex && this.monacoOf(a)) return a;
        return this.rows().find((r) => +r.dataset.index === oldIndex + 1 && this.monacoOf(r)) || null;
      }, 3000);
      if (!row) throw new Error('找不到新插入的单元格');
      if (oldIndex >= 0 && +row.dataset.index !== oldIndex + 1) via += '(末尾)';
      row.scrollIntoView({ block: 'center' });
      const m = await waitFor(() => { const x = this.monacoOf(row); return x && x.querySelector('.native-edit-context, textarea') ? x : null; });
      if (!m) throw new Error(WRITE_FAILED + ':新单元格的编辑器没有加载');
      const how = await this.writeMonaco(m, code);
      return { inserted: true, via: via + '+' + how, notice: this.kernelHint() };
    },
    async runCell() {
      const row = this.activeRow();
      if (!row) throw new Error('没有可运行的单元格');
      const btn = row.querySelector('.run-button-container a.codicon-notebook-execute, .run-button-container a[aria-label^="Execute Cell"]');
      if (!btn) throw new Error('找不到这个单元格的运行按钮（Execute Cell）');
      press(btn);
      await sleep(1500);
      return { ran: true, via: 'execute-button', notice: this.kernelHint() };
    }
  };

  function platformName() {
    const h = location.hostname;
    if (/(^|\.)aistudio\.baidu\.(com|test)$/.test(h)) return '飞桨 AI Studio';
    if (/(^|\.)modelscope\.(cn|test)$/.test(h) || /data\.aliyun\.com$/.test(h)) return 'ModelScope';
    if (/kaggle/.test(h)) return 'Kaggle';
    if (window.__nbacForceKaggle) return 'Kaggle';
    return 'Jupyter';
  }

  function pickAdapter() {
    if (jupyterLab.detect()) return jupyterLab;
    if (classicNotebook.detect()) return classicNotebook;
    if (vscodeNotebook.detect()) return vscodeNotebook;
    if (kaggle.detect()) return kaggle;
    return null;
  }

  const handlers = {
    detect() {
      const a = pickAdapter();
      if (!a) {
        const r = { detected: false, platform: platformName() };
        // 飞桨 AI Studio 外层的项目编辑器（/project/edit/…）不是 JupyterLab，提示进入 BML Codelab
        if (r.platform === '飞桨 AI Studio' && window.top === window && /\/project\/(edit|detail)\//.test(location.pathname)) {
          r.hint = '这是 AI Studio 外层的项目编辑器，暂不支持。请点击「专业开发」打开 BML Codelab 后使用';
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
      if (a === vscodeNotebook) r.notice = vscodeNotebook.kernelHint();
      return r;
    },
    getContext() {
      const a = pickAdapter();
      if (!a) throw new Error('当前页面没有检测到 Notebook');
      const r = { platform: platformName(), kind: a.kind, cellCode: a.getActiveCellCode(), errorOutput: a.getLastErrorOutput() };
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
    }
    document.dispatchEvent(new CustomEvent('nbac-response', { detail: JSON.stringify(resp) }));
  });
})();
