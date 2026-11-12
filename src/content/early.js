// 页面世界（MAIN world）、document_start：在页面脚本运行前给 addEventListener 加一个很轻的钩子，
// 记录“以对象形式注册的事件监听器”（Lumino/JupyterLab 的 widget 会 node.addEventListener(type, this)）。
// 这样即使页面没有暴露 window.jupyterapp，也能从 .jp-Notebook 节点找到 Notebook widget，直接改单元格模型。
// 只记录对象引用（WeakMap，不阻止回收），不改变事件行为。
(() => {
  if (window.__nbacEarly) return;
  const map = new WeakMap();
  Object.defineProperty(window, '__nbacEarly', { value: { listenerObjects: map }, enumerable: false });
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    try {
      if (listener && typeof listener === 'object' && typeof listener.handleEvent === 'function' && listener.node === this) {
        const prev = map.get(this);
        if (!prev || (!('activeCell' in prev) && 'activeCell' in listener)) map.set(this, listener);
      }
    } catch { /* ignore */ }
    return orig.call(this, type, listener, options);
  };
})();
