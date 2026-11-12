// 隔离世界的内容脚本：在扩展（侧边栏）和页面世界脚本 page.js 之间转发消息。
// 每个 frame 都会运行一份（all_frames）。检测时每个 frame 都通过 runtime 消息
// 回报自己的结果（含“不是 Notebook”），侧边栏根据 sender.frameId 选出真正有
// Notebook 的那个 frame，之后的操作都用 {frameId} 只发给它。
(() => {
  const BUILD = '0.1.9'; // 必须和 manifest 的 version、page.js 的 BUILD 一致
  if (window.__nbacBridgeBuild === BUILD) return;
  window.__nbacBridgeLoaded = true;
  window.__nbacBridgeBuild = BUILD;
  const REQ_EVENT = 'nbac-request-' + BUILD, RES_EVENT = 'nbac-response-' + BUILD;

  let seq = 0;
  const pending = new Map();

  document.addEventListener(RES_EVENT, (ev) => {
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
        resolve({ ok: false, error: 'timeout（页面脚本没有响应）' });
      }, timeoutMs);
      pending.set(id, (d) => { clearTimeout(timer); resolve(d); });
      document.dispatchEvent(new CustomEvent(REQ_EVENT, {
        detail: JSON.stringify({ id, action, args: args || {} })
      }));
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'nbac') return false;
    if (msg.action === 'detect') {
      callPage('detect', {}, 3000).then((r) => {
        const res = (r && r.ok && r.result) || { detected: false, error: r && r.error };
        chrome.runtime.sendMessage({
          type: 'nbac-detected', reqId: msg.reqId, url: location.href, top: window.top === window, ...res
        }).catch(() => {});
      });
      sendResponse({ ack: true });
      return false;
    }
    if (msg.action === 'diagnose') {
      callPage('diagnose', {}, 4000).then((r) => {
        const res = r && r.ok ? r.result : { url: location.origin + location.pathname, top: window.top === window, pageScript: false, error: r && r.error };
        chrome.runtime.sendMessage({ type: 'nbac-diag', reqId: msg.reqId, frame: res }).catch(() => {});
      });
      sendResponse({ ack: true });
      return false;
    }
    callPage(msg.action, msg.args, msg.timeoutMs || 15000).then(sendResponse);
    return true;
  });
})();
