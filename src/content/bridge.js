// 隔离世界的内容脚本：在扩展（侧边栏）和页面世界脚本 page.js 之间转发消息。
// 每个 frame 都会运行一份；只有检测到 Notebook 的 frame 才会回复，
// 后续请求带上 frameToken，保证只由同一个 frame 执行。
(() => {
  if (window.__nbacBridgeLoaded) return;
  window.__nbacBridgeLoaded = true;

  const frameToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let seq = 0;
  const pending = new Map();

  document.addEventListener('nbac-response', (ev) => {
    let data;
    try { data = JSON.parse(ev.detail); } catch { return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    p(data);
  });

  function callPage(action, args, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const id = 'r' + (++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      pending.set(id, (d) => { clearTimeout(timer); resolve(d); });
      document.dispatchEvent(new CustomEvent('nbac-request', {
        detail: JSON.stringify({ id, action, args: args || {} })
      }));
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'nbac') return false;
    if (msg.action === 'detect') {
      callPage('detect', {}, 3000).then((r) => {
        if (r && r.ok && r.result && r.result.detected) {
          sendResponse({ ok: true, frameToken, url: location.href, ...r.result });
        }
        // 未检测到：不回复，让其他 frame 回复
      });
      return true;
    }
    if (msg.frameToken !== frameToken) return false;
    callPage(msg.action, msg.args, msg.timeoutMs || 15000).then(sendResponse);
    return true;
  });
})();
