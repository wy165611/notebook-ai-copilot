// 侧边栏在页面上找不到内容脚本时，用 chrome.scripting 主动注入。这里是纯函数部分（方便单元测试）。
export const MAIN_SCRIPTS = ['src/content/early.js', 'src/content/nb-helpers.js', 'src/content/page.js'];
export const ISOLATED_SCRIPTS = ['src/content/bridge.js'];

// 把 chrome.scripting.executeScript 的报错分成几类
export function classifyInjectError(message, url) {
  const m = String(message || '');
  if (/polic|ExtensionsSettings|runtime_blocked_hosts|blocked by|blocked/i.test(m)) return 'policy';
  if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|devtools|extensions gallery|webstore|chrome web store|Cannot access a chrome/i.test(m)) return 'restricted';
  if (url && !/^(https?|file):/i.test(url)) return 'restricted';
  if (/Cannot access contents|must request permission|Missing host permission|permission/i.test(m)) return 'permission';
  if (/No tab with id|tab was closed|Frame with ID/i.test(m)) return 'gone';
  return 'other';
}

// "https://a.b.com:8443/x" -> "https://a.b.com/*"（匹配模式不带端口，覆盖这个域名的所有端口）
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch { return null; }
}

export function isInternalUrl(url) {
  return !!url && !/^(https?|file):/i.test(url);
}
