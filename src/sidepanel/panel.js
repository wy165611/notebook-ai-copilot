import {
  PRESETS, PROVIDER_IDS, THINKING_LEVELS, loadSettings, saveSettings, updateProvider,
  supportedThinking, listModels, generate, buildUserMessage, extractCode, extractShell, normalizeShell, bashCell,
  MODE_LABELS, normalizeMode, attachmentKind, prepareTextAttachment, MAX_FILE_CHARS
} from '../lib/llm.js';
import { ERR_READ_CODE, parseErrLine } from '../lib/errread.js';
import { PROBE_CODE, AUTO_PROBE_CODE, parseProbeOutput, mergeHardware, hardwareLabel } from '../lib/hardware.js';
import { MAIN_SCRIPTS, ISOLATED_SCRIPTS, classifyInjectError, originPattern, isInternalUrl } from '../lib/inject.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// 测试用：?tabId=123 可以把面板当普通页面打开并指定目标标签页
const forcedTabId = params.has('tabId') ? Number(params.get('tabId')) : null;

let target = null; // {tabId, frameId, platform, kind}
let busy = false;
let settings = null;
let lastPanelError = null;

const ICON = {
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
  insert: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  run: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
};

// ---------- Notebook 连接 ----------
function setStatus(text, cls) { const s = $('status'); s.textContent = text; s.className = 'status ' + (cls || ''); }

async function activeTabId() {
  if (forcedTabId) return forcedTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

const KIND_RANK = { jupyterlab: 3, 'vscode-notebook': 3, 'classic-notebook': 2, 'jupyterlab-terminal': 2, 'kaggle-dom': 1 };
let detectRetry = null;

// 向标签页里所有 frame 广播检测请求，收集各 frame 的回报（sender.frameId），选出真正有 Notebook 的 frame
async function collectReports(tabId, waitMs = 1500, action = 'detect', replyType = 'nbac-detected') {
  const reqId = Math.random().toString(36).slice(2);
  const reports = [];
  const listener = (msg, sender) => {
    if (!msg || msg.type !== replyType || msg.reqId !== reqId) return;
    if (!sender.tab || sender.tab.id !== tabId) return;
    reports.push({ ...msg, frameId: sender.frameId });
  };
  chrome.runtime.onMessage.addListener(listener);
  try {
    await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'nbac', action, reqId }), 3000);
  } catch { /* 页面上没有内容脚本 */ }
  await new Promise((r) => setTimeout(r, waitMs));
  chrome.runtime.onMessage.removeListener(listener);
  return reports;
}

function pickReport(reports) {
  const ok = reports.filter((r) => r.detected);
  ok.sort((x, y) => (KIND_RANK[y.kind] || 0) - (KIND_RANK[x.kind] || 0) || (y.cellCount || 0) - (x.cellCount || 0) || (x.top ? 1 : 0) - (y.top ? 1 : 0));
  return ok[0] || null;
}

// ---------- 没有内容脚本时主动注入 ----------
// 网站不在 manifest 的匹配列表里（自建 JupyterLab 等）、扩展更新后网页没刷新、或者浏览器没给内容脚本时，
// 用 chrome.scripting 把同一套脚本注入到所有 frame（脚本本身有 window 标记，重复注入不会出问题）
const injectState = new Map(); // tabId -> {ok, error, kind, at}
let siteAccessOrigins = null;  // 「在此网站启用助手」要申请的权限

async function injectInto(tabId) {
  const res = { at: new Date().toISOString() };
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: MAIN_SCRIPTS, world: 'MAIN', injectImmediately: true });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ISOLATED_SCRIPTS, injectImmediately: true });
    res.ok = true;
  } catch (e) {
    res.ok = false; res.error = String(e && e.message || e).slice(0, 300);
  }
  injectState.set(tabId, res);
  return res;
}

async function tabUrlOf(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; } // 没有 tabs 权限时 url 可能是空的
}

function showSiteAccess(show, hint, origins) {
  $('siteAccess').hidden = !show;
  siteAccessOrigins = origins || null;
  $('siteHint').textContent = hint || '';
  $('enableSite').textContent = origins && origins.length === 1 ? '在此网站启用助手' : '在此网站启用助手（允许访问所有网站）';
}

// 已保存的“检测硬件”结果：按顶层网页地址（不含参数）保存 12 小时
const HW_KEY = 'nbacHardware';
let pageHw = null; // 当前连接的硬件（合并后）
let hwKey = null;
let lastHints = []; // 当前网页各 frame 的页面硬件提示
function hwKeyFor(reports) {
  const top = reports.find((r) => r.top) || reports[0];
  try { const u = new URL(top.url); return u.origin + u.pathname; } catch { return null; }
}
async function savedProbe(key) {
  if (!key) return null;
  const all = (await chrome.storage.local.get(HW_KEY))[HW_KEY] || {};
  const v = all[key];
  return v && Date.now() - v.at < 12 * 3600 * 1000 ? v.hw : null;
}
async function saveProbe(key, hw) {
  if (!key) return;
  const all = (await chrome.storage.local.get(HW_KEY))[HW_KEY] || {};
  all[key] = { hw, at: Date.now() };
  for (const k of Object.keys(all)) if (Date.now() - all[k].at > 7 * 24 * 3600 * 1000) delete all[k];
  await chrome.storage.local.set({ [HW_KEY]: all });
}
function showHw(hw) {
  const e = $('hw');
  if (!target) { e.hidden = true; return; }
  e.hidden = false;
  const measured = hw && (hw.source === 'probe' || hw.cpuCores);
  e.textContent = '硬件：' + (probeRunning && !measured ? '正在自动检测显卡、显存、CPU 核数和内存…' : hardwareLabel(hw) +
    (probeFail && !measured ? (probeWait ? '（' + probeFail + '）' : '（自动检测没成功：' + probeFail + '，可以点「+ → 检测硬件」）') : ''));
  e.title = hw && hw.evidence ? '依据：' + hw.evidence : (hw && hw.source === 'probe' ? '来自“检测硬件”单元格的输出' : '“+ → 检测硬件”可以在 Notebook 里运行一段只读的检测代码');
}

async function refreshPageHw(reports) {
  const t = target;
  if (!t) return;
  try {
    const frames = [...new Set([t.frameId, ...reports.filter((r) => r.top).map((r) => r.frameId)])];
    const hints = [];
    for (const frameId of frames) {
      try {
        const r = await withTimeout(chrome.tabs.sendMessage(t.tabId, { type: 'nbac', action: 'hardwareHint', args: {} }, { frameId }), 3000);
        if (r && r.ok !== false) hints.push(r.result !== undefined ? r.result : r);
      } catch { /* ignore */ }
    }
    if (target !== t) return;
    lastHints = hints.concat(reports.map((r) => r.hw));
    const hw = mergeHardware(await savedProbe(hwKey), lastHints);
    if (hw) { pageHw = hw; t.hardware = hw; showHw(hw); }
  } catch { /* ignore */ }
}

// ---------- 自动识别当前界面是 Notebook 还是终端，并切换到对应的模式 ----------
// 每 2 秒问一次页面：JupyterLab 当前显示的标签页是 Notebook 还是终端。界面变了就自动切换模式；
// 你手动选的模式会一直保留到下一次界面变化。聊天模式不会被自动切走。
const VIEW_LABEL = { notebook: 'Notebook', terminal: '终端' };
let lastView = null;
let viewSwitched = false;
let viewBusy = false;
function showView(view) {
  const e = $('viewLine');
  if (!target || !view) { e.hidden = true; return; }
  e.hidden = false;
  e.textContent = '当前界面：' + VIEW_LABEL[view] + (viewSwitched ? '（已自动切换到「' + MODE_LABELS[view] + '」模式）' : '');
}
async function applyView(view) {
  if (!view || !target) { showView(null); return; }
  if (view !== lastView) {
    lastView = view;
    viewSwitched = false;
    if (currentMode() !== 'chat' && currentMode() !== view) { await setMode(view); viewSwitched = true; }
  }
  showView(view);
}
async function pollView() {
  const t = target;
  if (!t || viewBusy || document.hidden) return;
  viewBusy = true;
  try {
    const r = await withTimeout(chrome.tabs.sendMessage(t.tabId, { type: 'nbac', action: 'viewInfo', args: {} }, { frameId: t.frameId }), 3000);
    const res = r && r.ok !== false ? (r.result !== undefined ? r.result : r) : null;
    if (!res || target !== t) return;
    await applyView(res.view);
    // 之前只有终端，现在打开了 Notebook：重新检测，换成 Notebook 适配器
    if (res.view === 'notebook' && t.kind === 'jupyterlab-terminal') detect();
  } catch { /* 页面还没准备好 */ } finally { viewBusy = false; }
}
setInterval(pollView, 2000);

async function detect(attempt = 0, opts = {}) {
  clearTimeout(detectRetry);
  target = null;
  if (!attempt) setStatus('正在检测当前页面的 Notebook…');
  const tabId = await activeTabId();
  if (!tabId) { setStatus('没有找到当前标签页', 'bad'); return null; }
  let reports = await collectReports(tabId);
  let best = pickReport(reports);
  const tabUrl = await tabUrlOf(tabId);
  let injected = null;
  // 没有任何 frame 回报（或没有 Notebook）：注入脚本后再检测一次。每轮检测只在第 0 / 4 次尝试时注入
  if (!best && !isInternalUrl(tabUrl) && (attempt === 0 || attempt === 4 || opts.forceInject)) {
    injected = await injectInto(tabId);
    if (injected.ok) {
      await new Promise((r) => setTimeout(r, 300));
      reports = await collectReports(tabId);
      best = pickReport(reports);
    }
  }
  if (best) {
    showSiteAccess(false);
    target = { tabId, frameId: best.frameId, platform: best.platform, kind: best.kind };
    const where = best.top ? '主页面' : '内嵌 frame';
    setStatus(`已连接：${best.platform}（${best.kind}${best.viaApp ? '，JupyterLab API' : best.viaModel ? '，JupyterLab 模型' : ''}，${where}）`, 'ok');
    hwKey = hwKeyFor(reports);
    lastHints = reports.map((r) => r.hw);
    pageHw = mergeHardware(await savedProbe(hwKey), lastHints);
    target.hardware = pageHw;
    showHw(pageHw);
    applyView(best.view);
    refreshPageHw(reports).then(() => autoProbe(target)); // 页面文字扫描放在检测之后做，避免拖慢检测
    if (best.notice) showNotice(best.notice);
    else if (injected && injected.ok) showNotice('这个网页没有自动加载助手，已经在当前网页里手动加载好了（刷新网页后会自动重新加载）。');
    else if (best.kind === 'vscode-notebook' && /内核/.test($('notice').textContent)) showNotice('');
    $('status').title = reports.map((r) => `frame ${r.frameId}${r.top ? '(top)' : ''}: ${r.detected ? r.kind + ' ' + r.cellCount + ' 个单元格' : '不是 Notebook'}  ${String(r.url).split('?')[0]}`).join('\n');
    return target;
  }
  showHw(null);
  showView(null);
  const hint = reports.find((r) => r.hint);
  const inj = injectState.get(tabId);
  const kind = inj && !inj.ok ? classifyInjectError(inj.error, tabUrl) : null;
  let msg;
  let stop = false;
  showSiteAccess(false);
  if (hint) msg = hint.hint;
  else if (isInternalUrl(tabUrl) || kind === 'restricted') {
    msg = '当前标签页是浏览器内部页面（chrome:// 设置页、扩展商店等），扩展不能在这里运行：请切换到 Notebook 网页的标签页';
  } else if (kind === 'policy') {
    msg = '这个浏览器由组织管理，组织策略禁止扩展在这个网站上运行（Chrome 报错：' + inj.error + '）。请联系管理员把这个网站加入允许列表，或换一个不受管理的 Chrome 用户资料';
    stop = true;
  } else if (kind === 'permission') {
    const pat = originPattern(tabUrl);
    msg = '助手还没有访问这个网站的权限，所以读不到 Notebook';
    showSiteAccess(true, pat
      ? '点下面的按钮，Chrome 会询问是否允许助手访问 ' + pat.replace('/*', '') + '（只申请这一个网站）'
      : '也可以先点一下浏览器工具栏里的助手图标（临时允许当前网页），再点「+ → 重新检测」', pat ? [pat] : ['https://*/*', 'http://*/*']);
    stop = true;
  } else if (!reports.length) {
    msg = inj && inj.ok
      ? '助手脚本已加载，但页面没有响应：请刷新这个网页再试'
      : '这个网页还没加载助手脚本：请刷新这个网页（扩展重新加载或更新后，已打开的网页都要刷新一次），再打开一个 .ipynb';
  } else msg = '没有检测到 Notebook：打开 AI Studio / ModelScope / Kaggle / 安睿云 JupyterLab 的 Notebook，加载完后点“+ → 重新检测”';
  setStatus(msg, 'bad');
  $('status').title = reports.map((r) => `frame ${r.frameId}: 不是 Notebook  ${String(r.url).split('?')[0]}`).join('\n') + (inj && !inj.ok ? '\n注入失败：' + inj.error : '');
  // Notebook（尤其是 Kaggle 的 iframe）常常比页面晚加载：自动重试一会儿
  if (!stop && attempt < 20) detectRetry = setTimeout(() => detect(attempt + 1), 3000);
  return null;
}

// 用户点「在此网站启用助手」：必须在点击事件里直接调用 permissions.request
async function enableSite(origins, alreadyGranted) {
  let granted = !!alreadyGranted;
  if (!granted) {
    try { granted = await chrome.permissions.request({ origins }); } catch (e) {
      lastPanelError = { action: 'permissions.request', message: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
      setStatus('申请权限失败：' + (e.message || e), 'bad'); return false;
    }
  }
  if (!granted) { setStatus('没有获得访问这个网站的权限，助手不能在这里使用', 'bad'); return false; }
  // 以后打开这个网站时自动加载（和 manifest 里的内容脚本一样）
  try {
    const id = 'nbac-' + origins.join(',').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
    const ids = [id + '-early', id + '-page', id + '-bridge'];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
    await chrome.scripting.registerContentScripts([
      { id: ids[0], matches: origins, js: [MAIN_SCRIPTS[0]], world: 'MAIN', allFrames: true, runAt: 'document_start' },
      { id: ids[1], matches: origins, js: MAIN_SCRIPTS.slice(1), world: 'MAIN', allFrames: true, runAt: 'document_idle' },
      { id: ids[2], matches: origins, js: ISOLATED_SCRIPTS, allFrames: true, runAt: 'document_idle' }
    ]);
  } catch (e) {
    lastPanelError = { action: 'registerContentScripts', message: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
  }
  showSiteAccess(false);
  await detect(0, { forceInject: true });
  return !!target;
}

async function call(action, args) {
  if (!target) await detect();
  if (!target) throw new Error('未连接到 Notebook');
  const send = () => chrome.tabs.sendMessage(target.tabId, { type: 'nbac', action, args }, { frameId: target.frameId });
  let r;
  try { r = await send(); } catch (e) {
    // 页面或 iframe 刷新过，重新检测一次再试
    await detect();
    if (!target) throw e;
    r = await send();
  }
  if (!r) throw new Error('页面没有响应');
  if (!r.ok) throw new Error(r.error || '操作失败');
  return r.result;
}

// ---------- 设置：服务商 / 模型 / 思考强度 ----------
async function refreshSettings() { settings = await loadSettings(); renderBar(); renderMode(); }
function cur() { return settings.providers[settings.active]; }

function renderBar() {
  const p = PRESETS[settings.active];
  const c = cur();
  $('modelLabel').textContent = c.model ? c.model : '选择模型';
  $('modelBtn').title = `${p.label} · ${c.model || '未选择模型'}` + (c.apiKey ? '' : '（还没填 API Key）');
  const sup = supportedThinking(settings.active, c.model);
  const level = sup.includes(settings.thinking) ? settings.thinking : 'default';
  const lbl = THINKING_LEVELS.find((l) => l.id === level).label;
  $('thinkLabel').textContent = level === 'default' ? '' : lbl;
  $('thinkBtn').classList.toggle('active', level !== 'default');
  $('thinkBtn').classList.toggle('with-label', level !== 'default');
  $('thinkBtn').title = '思考强度：' + lbl;
  $('includeContext').checked = !!settings.includeContext;
  $('autoFix').checked = !!settings.autoFix;
  $('ctxChip').hidden = !settings.includeContext;
  $('plusBtn').classList.toggle('active', !!settings.includeContext);
  if (!c.apiKey) showNotice(`「${p.label}」还没有填写 API Key，点右上角 ⋮ 打开设置。`);
}

function showNotice(t) { const n = $('notice'); n.textContent = t || ''; n.hidden = !t; }

function closeMenus(except) {
  for (const id of ['plusMenu', 'thinkMenu', 'modelMenu']) if (id !== except) $(id).hidden = true;
}
function toggleMenu(id) { const m = $(id); const open = m.hidden; closeMenus(id); m.hidden = !open; return open; }

function renderThinkMenu() {
  const c = cur();
  const sup = supportedThinking(settings.active, c.model);
  const box = $('thinkOptions');
  box.innerHTML = '';
  for (const l of THINKING_LEVELS) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (settings.thinking === l.id ? ' selected' : '');
    b.dataset.level = l.id;
    b.textContent = l.label + (l.id === 'default' ? '（不传参数，用模型默认）' : '');
    if (!sup.includes(l.id)) { b.disabled = true; b.title = '当前模型不支持这个档位'; }
    b.addEventListener('click', async () => {
      await saveSettings({ thinking: l.id });
      await refreshSettings();
      closeMenus();
    });
    box.appendChild(b);
  }
  $('thinkHint').textContent = `当前：${PRESETS[settings.active].label} · ${c.model || '未选择'}；灰色档位此模型不支持。`;
}

function renderProviderSelect() {
  const sel = $('providerSelect');
  sel.innerHTML = '';
  for (const id of PROVIDER_IDS) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = PRESETS[id].label + (settings.providers[id].apiKey ? '' : '（未填 Key）');
    sel.appendChild(o);
  }
  sel.value = settings.active;
}

function renderModelList(models, hint, isErr) {
  const c = cur();
  const p = PRESETS[settings.active];
  const all = Array.from(new Set([...(models || []), ...p.suggestions]));
  const dl = $('modelList');
  dl.replaceChildren(...all.map((m) => { const o = document.createElement('option'); o.value = m; return o; }));
  const box = $('modelListBox');
  box.innerHTML = '';
  const q = $('modelInput').value.trim().toLowerCase();
  for (const m of all) {
    if (q && q !== c.model.toLowerCase() && !m.toLowerCase().includes(q)) continue;
    const b = document.createElement('button');
    b.className = 'menu-item' + (m === c.model ? ' selected' : '');
    b.dataset.model = m;
    b.textContent = m + (m.includes('/') ? '  ·第三方' : '');
    b.addEventListener('click', () => chooseModel(m));
    box.appendChild(b);
  }
  const h = $('modelHint');
  h.textContent = hint || '';
  h.className = 'menu-hint' + (isErr ? ' err' : '');
}

async function loadModelList(force) {
  const id = settings.active;
  const c = cur();
  const cache = settings.modelCache[id];
  if (!force && cache && cache.models && cache.models.length) {
    renderModelList(cache.models, `已缓存 ${cache.models.length} 个对话模型（${new Date(cache.ts).toLocaleString()}），可点“刷新列表”。`);
    return;
  }
  if (!c.apiKey) { renderModelList([], '还没填 API Key，先显示常用模型；也可以直接输入模型 ID。', true); return; }
  renderModelList([], '正在获取模型列表…');
  try {
    const models = await listModels(id, c);
    const modelCache = { ...settings.modelCache, [id]: { ts: Date.now(), models } };
    await saveSettings({ modelCache });
    settings.modelCache = modelCache;
    renderModelList(models, `共 ${models.length} 个对话模型（已过滤语音/向量/图像等）。带 “/” 的是第三方模型，可能需要先在控制台开通。`);
  } catch (e) {
    renderModelList([], '获取模型列表失败：' + (e.message || e) + '\n可以直接输入模型 ID。', true);
  }
}

async function chooseModel(m) {
  m = String(m || '').trim();
  if (!m) return;
  await updateProvider(settings.active, { model: m });
  await refreshSettings();
  $('modelInput').value = m;
  renderModelList(settings.modelCache[settings.active] ? settings.modelCache[settings.active].models : [], `已切换到 ${m}`);
}

// ---------- 对话 ----------
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function scrollDown() { const c = $('chat'); c.scrollTop = c.scrollHeight; }

// ---------- 对话记录：像 Gemini 网页版一样保存多个对话（chrome.storage.local，不含 API Key） ----------
// nbacConvIndex = {currentId, list:[{id, title, createdAt, updatedAt, count}]}，每个对话的消息存在 nbacConv:<id>
const CONV_INDEX = 'nbacConvIndex';
const CONV_PREFIX = 'nbacConv:';
const OLD_CHAT_KEY = 'nbacChatHistory'; // 0.1.13 的单一聊天记录，打开时迁移成一个对话
const CONV_MAX = 100;
const MSG_MAX = 200;
const LLM_MAX = 12000; // 每条发给模型的上下文最多存这么多字
let convIndex = { currentId: null, list: [] };
let chatLog = []; // 当前对话的消息 [{id, role:'user'|'bot', mode, text, code, meta, info, error, llm, attachments, ts}]
let chatSave = Promise.resolve();
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const validMsg = (r) => r && r.id && (r.role === 'user' || r.role === 'bot');
function titleFrom(msgs) {
  const u = (msgs || []).find((r) => r.role === 'user' && (r.text || '').trim());
  const t = u ? u.text.replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > 30 ? t.slice(0, 30) + '…' : t) : '新对话';
}
async function loadMessages(id) {
  const v = (await chrome.storage.local.get(CONV_PREFIX + id))[CONV_PREFIX + id];
  return Array.isArray(v) ? v.filter(validMsg) : [];
}
async function loadChat() {
  try {
    const st = await chrome.storage.local.get([CONV_INDEX, OLD_CHAT_KEY]);
    let idx = st[CONV_INDEX];
    if (!idx || !Array.isArray(idx.list)) {
      idx = { currentId: null, list: [] };
      const old = Array.isArray(st[OLD_CHAT_KEY]) ? st[OLD_CHAT_KEY].filter(validMsg).slice(-MSG_MAX) : [];
      if (old.length) {
        const id = newId();
        idx.list.push({ id, title: titleFrom(old), createdAt: old[0].ts || Date.now(), updatedAt: old[old.length - 1].ts || Date.now(), count: old.length });
        idx.currentId = id;
        await chrome.storage.local.set({ [CONV_PREFIX + id]: old });
      }
      await chrome.storage.local.set({ [CONV_INDEX]: idx });
      await chrome.storage.local.remove(OLD_CHAT_KEY);
    }
    if (idx.currentId && !idx.list.some((c) => c.id === idx.currentId)) idx.currentId = null;
    convIndex = idx;
    chatLog = idx.currentId ? await loadMessages(idx.currentId) : [];
  } catch { convIndex = { currentId: null, list: [] }; chatLog = []; }
}
function saveIndex() {
  const snap = JSON.parse(JSON.stringify(convIndex));
  chatSave = chatSave.then(() => chrome.storage.local.set({ [CONV_INDEX]: snap })).catch(() => {});
  return chatSave;
}
// 保存一个对话的消息；存储满了就删掉最旧的对话再试
function saveMessages(id, msgs) {
  const snap = msgs.slice(-MSG_MAX);
  chatSave = chatSave.then(async () => {
    for (let i = 0; i < 5; i++) {
      try { await chrome.storage.local.set({ [CONV_PREFIX + id]: snap }); return; } catch (e) {
        const others = convIndex.list.filter((c) => c.id !== id).sort((a, b) => a.updatedAt - b.updatedAt);
        if (!others.length) return;
        convIndex.list = convIndex.list.filter((c) => c.id !== others[0].id);
        await chrome.storage.local.remove(CONV_PREFIX + others[0].id).catch(() => {});
        await chrome.storage.local.set({ [CONV_INDEX]: convIndex }).catch(() => {});
      }
    }
  }).catch(() => {});
  return chatSave;
}
function touchConv(id, msgs) {
  const c = convIndex.list.find((x) => x.id === id);
  if (!c) return;
  c.updatedAt = Date.now(); c.count = msgs.length;
  if (!c.renamed) c.title = titleFrom(msgs);
  // 最多保留 CONV_MAX 个对话：删掉最久没用的
  if (convIndex.list.length > CONV_MAX) {
    const drop = convIndex.list.slice().sort((a, b) => a.updatedAt - b.updatedAt).slice(0, convIndex.list.length - CONV_MAX).filter((x) => x.id !== convIndex.currentId);
    for (const d of drop) chrome.storage.local.remove(CONV_PREFIX + d.id).catch(() => {});
    const ids = new Set(drop.map((d) => d.id));
    convIndex.list = convIndex.list.filter((x) => !ids.has(x.id));
  }
}
// 记一条消息。convId：发送时所在的对话（生成期间用户切到别的对话，回答仍记到原来的对话里）
function record(rec, convId) {
  const r = { id: newId(), ts: Date.now(), ...rec };
  if (!convId) {
    if (!convIndex.currentId) {
      const id = newId();
      convIndex.list.push({ id, title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), count: 0 });
      convIndex.currentId = id;
    }
    convId = convIndex.currentId;
  }
  if (convId === convIndex.currentId) {
    chatLog.push(r);
    if (chatLog.length > MSG_MAX) chatLog = chatLog.slice(-MSG_MAX);
    touchConv(convId, chatLog); saveMessages(convId, chatLog); saveIndex();
  } else if (convIndex.list.some((c) => c.id === convId)) {
    chatSave = chatSave.then(async () => {
      const msgs = (await loadMessages(convId)).concat(r);
      touchConv(convId, msgs); saveMessages(convId, msgs); saveIndex();
    }).catch(() => {});
  }
  r.convId = convId;
  return r;
}
function updateRecord(r, patch) {
  Object.assign(r, patch);
  if (r.convId === convIndex.currentId && chatLog.includes(r)) saveMessages(r.convId, chatLog);
}
// 发给模型的历史：只用当前对话里完整的「用户 → 回答」对，最近 3 轮
function llmHistory() {
  const out = [];
  for (let i = 0; i < chatLog.length - 1; i++) {
    const u = chatLog[i], b = chatLog[i + 1];
    if (u.role === 'user' && u.llm && b.role === 'bot' && b.llm) { out.push({ role: 'user', content: u.llm }, { role: 'assistant', content: b.llm }); i++; }
  }
  return out.slice(-6);
}
async function openConversation(id) {
  if (!convIndex.list.some((c) => c.id === id)) return;
  convIndex.currentId = id;
  chatLog = await loadMessages(id);
  renderChatLog(); saveIndex(); closeDrawer(); showNotice('');
}
function newConversation() {
  convIndex.currentId = null; chatLog = [];
  renderChatLog(); saveIndex(); closeDrawer(); showNotice('');
  $('prompt').focus();
}
async function deleteConversation(id) {
  convIndex.list = convIndex.list.filter((c) => c.id !== id);
  await chrome.storage.local.remove(CONV_PREFIX + id).catch(() => {});
  if (convIndex.currentId === id) { convIndex.currentId = null; chatLog = []; renderChatLog(); }
  await saveIndex();
  renderDrawer();
}
async function deleteAllConversations() {
  const keys = convIndex.list.map((c) => CONV_PREFIX + c.id);
  convIndex = { currentId: null, list: [] }; chatLog = [];
  await chrome.storage.local.remove(keys).catch(() => {});
  await saveIndex();
  renderChatLog(); renderDrawer();
}
async function renameConversation(id, title) {
  const c = convIndex.list.find((x) => x.id === id);
  if (!c || !title.trim()) return;
  c.title = title.trim().slice(0, 60); c.renamed = true;
  await saveIndex(); renderDrawer();
}

// ---------- 对话列表（左侧抽屉） ----------
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}
function renderDrawer() {
  const box = $('convList');
  box.innerHTML = '';
  const list = convIndex.list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  $('convEmpty').hidden = list.length > 0;
  $('convDeleteAll').disabled = !list.length;
  for (const c of list) {
    const item = el('div', 'conv-item' + (c.id === convIndex.currentId ? ' current' : ''));
    item.dataset.id = c.id;
    const main = el('button', 'conv-open');
    main.appendChild(el('span', 'conv-title', escapeHtml(c.title || '新对话')));
    main.appendChild(el('span', 'conv-time', escapeHtml(fmtTime(c.updatedAt) + (c.count ? ' · ' + c.count + ' 条' : ''))));
    main.title = c.title || '';
    main.addEventListener('click', () => openConversation(c.id));
    const ren = el('button', 'conv-rename', '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>');
    ren.title = '重命名';
    const del = el('button', 'conv-del', '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>');
    del.title = '删除这个对话';
    const confirm = el('div', 'conv-confirm');
    confirm.hidden = true;
    confirm.appendChild(el('span', null, '删除这个对话？'));
    const yes = el('button', 'act danger conv-del-yes', '删除');
    const no = el('button', 'act conv-del-no', '取消');
    confirm.append(yes, no);
    del.addEventListener('click', (e) => { e.stopPropagation(); confirm.hidden = false; });
    no.addEventListener('click', (e) => { e.stopPropagation(); confirm.hidden = true; });
    yes.addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(c.id); });
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = el('input', 'conv-rename-input');
      input.value = c.title || '';
      main.replaceWith(input); input.focus(); input.select();
      const done = (save) => { if (save) renameConversation(c.id, input.value); else renderDrawer(); };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    });
    const row = el('div', 'conv-row');
    row.append(main, ren, del);
    item.append(row, confirm);
    box.appendChild(item);
  }
}
function openDrawer() { closeMenus(); renderDrawer(); $('convAllConfirm').hidden = true; $('convDrawer').hidden = false; $('drawerMask').hidden = false; }
function closeDrawer() { $('convDrawer').hidden = true; $('drawerMask').hidden = true; }

// ---------- 聊天模式的附件（图片 / 文本类文件） ----------
const MAX_ATTACH = 8;
let pendingAtt = []; // [{id, kind:'image'|'file', name, size, dataUrl?, text?, truncated?, lang?}]
function readAs(file, how) {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => bad(r.error); r[how](file); });
}
// 大图片缩到最长边 2048 像素（JPEG），避免请求太大
async function shrinkImage(file, dataUrl) {
  if (file.size < 1.5 * 1024 * 1024 || /gif/i.test(file.type)) return dataUrl;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } catch { return dataUrl; }
}
async function addFiles(files) {
  const bad = [];
  for (const f of Array.from(files || [])) {
    if (pendingAtt.length >= MAX_ATTACH) { bad.push(f.name + '（一次最多 ' + MAX_ATTACH + ' 个附件）'); continue; }
    const kind = attachmentKind(f.name, f.type);
    if (!kind) { bad.push(f.name + '（只支持图片和文本类文件）'); continue; }
    try {
      if (kind === 'image') {
        if (f.size > 20 * 1024 * 1024) { bad.push(f.name + '（图片超过 20 MB）'); continue; }
        const dataUrl = await shrinkImage(f, await readAs(f, 'readAsDataURL'));
        pendingAtt.push({ id: newId(), kind, name: f.name || 'image.png', size: f.size, dataUrl, mime: f.type });
      } else {
        // 只读前面一部分：超过上限的文件会截断并注明
        const raw = /\.ipynb$/i.test(f.name) ? await f.text() : await f.slice(0, MAX_FILE_CHARS * 4 + 16).text();
        const a = prepareTextAttachment(f.name, raw);
        if (!/\.ipynb$/i.test(f.name) && f.size > raw.length && !a.truncated) { a.text += '\n…（后面还有内容，文件太长已截断）'; a.truncated = true; }
        pendingAtt.push({ id: newId(), ...a, size: f.size });
      }
    } catch (e) { bad.push(f.name + '（读取失败：' + (e && e.message || e) + '）'); }
  }
  renderAttachments();
  if (bad.length) showNotice('没有添加：' + bad.join('；') + '。支持图片（png / jpg / webp / gif）和文本类文件（txt、md、py、ipynb、csv、json、yaml、log 等）。');
}
function renderAttachments() {
  const box = $('attachChips');
  box.innerHTML = '';
  for (const a of pendingAtt) {
    const chip = el('div', 'att-chip att-' + a.kind);
    if (a.kind === 'image') { const img = el('img'); img.src = a.dataUrl; img.alt = ''; chip.appendChild(img); }
    else chip.appendChild(el('span', 'att-icon', '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>'));
    chip.appendChild(el('span', 'att-name', escapeHtml(a.name) + (a.truncated ? '（已截断）' : '')));
    const x = el('button', 'att-remove', '×');
    x.title = '移除这个附件';
    x.addEventListener('click', (e) => { e.stopPropagation(); pendingAtt = pendingAtt.filter((p) => p.id !== a.id); renderAttachments(); });
    chip.appendChild(x);
    box.appendChild(chip);
  }
  box.hidden = !pendingAtt.length;
}

function addUser(text, rec) {
  $('welcome').hidden = true;
  const m = el('div', 'msg user');
  const col = el('div', 'user-col');
  const atts = rec && rec.attachments;
  if (atts && atts.length) {
    const row = el('div', 'msg-atts');
    for (const a of atts) row.appendChild(el('span', 'msg-att', escapeHtml((a.kind === 'image' ? '🖼 ' : '📄 ') + a.name)));
    col.appendChild(row);
  }
  const b = el('div', 'bubble'); b.textContent = text;
  col.appendChild(b);
  if (rec && rec.mode && rec.mode !== 'notebook') m.appendChild(el('span', 'mode-tag', escapeHtml(MODE_LABELS[rec.mode] || '')));
  m.appendChild(col);
  $('messages').appendChild(m);
  scrollDown();
  return m;
}

function addThinking(text) {
  const m = el('div', 'msg bot pending', '<div class="thinking"><span class="dot"></span><span class="thinking-text">' + escapeHtml(text || '正在思考…') + '</span></div>');
  $('messages').appendChild(m);
  scrollDown();
  return m;
}

async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = fallbackEl || document.createElement('textarea');
    if (!fallbackEl) { t.value = text; document.body.appendChild(t); }
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (!fallbackEl) t.remove();
    return ok;
  }
}

// 聊天模式的回答：先转义，再做简单的排版（段落、行内代码、带复制按钮的代码块）
function renderAnswer(text) {
  const box = el('div', 'answer');
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0, mm;
  const addText = (t) => {
    for (const para of t.split(/\n{2,}/)) {
      const p = para.replace(/^\n+|\n+$/g, '');
      if (!p.trim()) continue;
      const e = el('p', null, escapeHtml(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>'));
      box.appendChild(e);
    }
  };
  while ((mm = re.exec(text))) {
    addText(text.slice(last, mm.index));
    const code = mm[2].replace(/\s+$/, '');
    const blk = el('div', 'codeblock');
    const head = el('div', 'lang');
    head.appendChild(el('span', null, escapeHtml(mm[1] || 'code')));
    const cp = el('button', 'copy-mini', '复制');
    cp.addEventListener('click', async () => { cp.textContent = (await copyText(code)) ? '已复制' : '复制失败'; setTimeout(() => { cp.textContent = '复制'; }, 1500); });
    head.appendChild(cp);
    blk.appendChild(head);
    const pre = el('pre'); const c = el('code'); c.textContent = code; pre.appendChild(c); blk.appendChild(pre);
    box.appendChild(blk);
    last = re.lastIndex;
  }
  addText(text.slice(last));
  return box;
}

// ---------- 运行后自动读取结果：等单元格跑完，出错时提供「根据运行结果继续」（可选自动修复，但不会自动运行） ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function watchRun(m, runId, setResult, base, mode) {
  const t0 = Date.now();
  let said = false;
  while (m.isConnected && Date.now() - t0 < 6 * 3600 * 1000) {
    await sleep(1500);
    if (!m.isConnected) return;
    let st;
    try { st = await call('runStatus', { runId }); } catch { continue; }
    if (!st || ['none', 'stale', 'gone', 'unsupported'].includes(st.state)) return;
    if (st.state === 'pending' && Date.now() - t0 > 10 * 60 * 1000) return;
    if (st.state === 'running' || st.state === 'pending') {
      if (!said && Date.now() - t0 > 2500) { said = true; setResult(base + '。正在运行，跑完后会自动读取运行结果'); }
      continue;
    }
    if (st.state === 'done') { showRunDone(m, st, setResult, base, mode); return; }
  }
}
function showRunDone(m, st, setResult, base, mode) {
  const err = !!st.error;
  setResult(base + (err ? '。运行出错了' + (st.unreadable ? '（输出在单独的安全框里读不到，点下面的按钮会先自动读取报错）' : '') + '，可以点「根据运行结果继续」' : '。运行完成，可以点「根据运行结果继续」让我看输出、给下一步'), err);
  const old = m.querySelector('.run-next');
  if (old) old.remove();
  const box = el('div', 'code-actions run-next');
  const b = el('button', 'act act-continue ' + (err ? 'danger strong' : 'primary'), ICON.run + '根据运行结果继续');
  b.title = '读取刚才运行的输出' + (err ? '和报错' : '') + '，生成下一步要运行的' + (mode === 'terminal' ? '命令' : '代码') + '（不会自动运行）';
  b.addEventListener('click', () => { if (!busy) send(true, { run: st, mode }); });
  box.appendChild(b);
  m.appendChild(box);
  scrollDown();
  if (err && settings.autoFix && !busy) send(true, { run: st, mode, auto: true });
}

// VS Code 网页版：输出读不到时，插入并运行一个只读的「读取报错」单元格，让内核把上一次报错写回单元格文字
async function readVsError(onStatus) {
  let before = 0;
  try { const r0 = await call('readErrorWriteBack', {}); before = (r0 && r0.count) || 0; } catch { /* ignore */ }
  if (onStatus) onStatus('输出读不到，正在插入一个只读的「读取报错」单元格并运行…');
  await call('insertCellBelow', { code: ERR_READ_CODE });
  await call('runCell', {});
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    let r;
    try { r = await call('readErrorWriteBack', {}); } catch { continue; }
    if (r && r.count > before) { const e = parseErrLine(r.line); if (e) return e; }
  }
  return null;
}

function renderBot(m, { text, code, meta, error, onRan, info, mode, rec, notes }) {
  mode = normalizeMode(mode);
  m.className = 'msg bot' + (error ? ' err' : '') + ' mode-' + mode;
  m.innerHTML = '';
  if (rec) m.dataset.id = rec.id;
  if (meta) m.appendChild(el('div', 'meta', escapeHtml(meta)));
  if (error) { m.appendChild(el('div', 'text', escapeHtml(error))); return; }
  if (info) { m.appendChild(el('div', 'text hw-info', escapeHtml(info))); return; }
  if (mode === 'chat') { m.appendChild(renderAnswer(text || '')); scrollDown(); return; }
  const term = mode === 'terminal';
  const outside = (text || '').replace(/```[\s\S]*?```/g, '').trim();
  if (outside) m.appendChild(el('div', 'text', escapeHtml(outside.slice(0, 600))));
  const block = el('div', 'codeblock');
  block.appendChild(el('div', 'lang', term ? 'Bash · 终端命令，可直接修改' : 'Python · 可直接修改后再插入'));
  const ta = el('textarea'); ta.spellcheck = false; ta.value = code || '';
  ta.rows = Math.min(22, Math.max(4, ta.value.split('\n').length + 1));
  block.appendChild(ta);
  m.appendChild(block);
  const acts = el('div', 'code-actions');
  const bCopy = el('button', 'act act-copy', ICON.copy + '复制');
  const bIns = term ? null : el('button', 'act primary act-insert', ICON.insert + '插入到新单元格');
  const bRun = term ? el('button', 'act danger act-run act-bash', ICON.run + '在 Notebook 里运行') : el('button', 'act danger act-run', ICON.run + '插入并运行');
  acts.append(...[bCopy, bIns, bRun].filter(Boolean));
  m.appendChild(acts);
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  confirm.innerHTML = term
    ? '确认把这些命令放进一个 <code>%%bash</code> 单元格，插入到当前单元格下方并<strong>立即运行</strong>吗？'
    : '确认把这段代码插入到当前单元格下方并<strong>立即运行</strong>吗？';
  const cActs = el('div', 'code-actions');
  const bOk = el('button', 'act danger act-confirm', ICON.run + '确认运行');
  const bNo = el('button', 'act act-cancel', '取消');
  cActs.append(bOk, bNo); confirm.appendChild(cActs);
  m.appendChild(confirm);
  const result = el('div', 'result');
  m.appendChild(result);
  const btns = [bIns, bRun, bOk].filter(Boolean);

  const setResult = (t, err) => { result.textContent = t; result.className = 'result' + (err ? ' err' : ''); };
  if (notes) setResult('提示：' + notes + '。');
  bCopy.addEventListener('click', async () => {
    await copyText(ta.value, ta);
    setResult(term ? '已复制。到终端里粘贴并回车运行，运行完点「+ → 修复当前报错」，我会自动读取终端里的输出，给你下一步' : '已复制');
  });
  const doInsert = async (andRun) => {
    if (!ta.value.trim()) { setResult('没有可插入的代码', true); return; }
    const cellCode = term ? bashCell(ta.value) : ta.value;
    for (const b of btns) b.disabled = true;
    const old = m.querySelector('.run-next');
    if (old) old.remove();
    try {
      const r = await call('insertCellBelow', { code: cellCode });
      if (/footer|末尾/.test(r.via)) r.via += '，找不到“在下方插入”，已加到 Notebook 末尾';
      if (r.notice) showNotice(r.notice);
      const intoEmpty = /^current-empty-cell/.test(r.via);
      const where = intoEmpty ? '没法新建单元格，已写入当前选中的空单元格' : (term ? '已插入 %%bash 单元格' : '已插入新单元格');
      if (andRun) {
        let rr;
        try { rr = await call('runCell', {}); } catch (e) {
          // 插入成功、运行失败：不要说“插入失败”，告诉用户手动运行
          const msg = String(e.message || e).replace(/^NBAC_RUN_FAILED:/, '');
          lastPanelError = { action: 'run', message: msg.slice(0, 300), at: new Date().toISOString() };
          setResult(`${where}（${r.via}），但没有自动运行：${msg}。请在 Notebook 里点一下这个单元格，按 Shift+Enter 运行`, true);
          showNotice('自动运行失败。如果一直这样，可以点“+ → 复制诊断信息”发给开发者');
          return;
        }
        if (rr && rr.notice) showNotice(rr.notice);
        const base = `${where}并开始运行（${r.via}；运行：${rr && rr.via || '?'}）`;
        setResult(base);
        if (onRan) onRan(setResult);
        else if (rr && rr.runId) watchRun(m, rr.runId, setResult, base, mode);
      } else setResult(`${intoEmpty ? where : '已插入到新单元格'}（${r.via}），检查无误后在 Notebook 里运行`);
    } catch (e) {
      // 插入或写入失败：把代码放到剪贴板，让用户手动粘贴；不运行
      lastPanelError = { action: andRun ? 'insert+run' : 'insert', message: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
      let msg = String(e.message || e);
      const writeFailed = msg.startsWith('NBAC_WRITE_FAILED:');
      if (writeFailed) msg = msg.slice('NBAC_WRITE_FAILED:'.length);
      let copied = true;
      try { await navigator.clipboard.writeText(cellCode); } catch { try { ta.select(); copied = document.execCommand('copy'); } catch { copied = false; } }
      setResult('插入失败：' + msg + (copied ? '。代码已复制到剪贴板，请点进 Notebook 的单元格按 Ctrl+V（Mac 上 ⌘V）粘贴' : '。请点“复制”后手动粘贴') + (andRun ? '（没有运行）' : ''), true);
      showNotice((writeFailed ? '自动写入单元格失败' : '自动插入单元格失败') + (copied ? '，代码已复制到剪贴板' : '') + '。如果一直这样，可以点“+ → 复制诊断信息”发给开发者');
    }
    finally { for (const b of btns) b.disabled = false; confirm.hidden = true; }
  };
  if (bIns) bIns.addEventListener('click', () => doInsert(false));
  bRun.addEventListener('click', () => { confirm.hidden = false; scrollDown(); });
  bNo.addEventListener('click', () => { confirm.hidden = true; });
  bOk.addEventListener('click', () => doInsert(true));
  scrollDown();
}

// 把当前对话的消息画出来（按钮照常能用）
function renderChatLog() {
  $('messages').innerHTML = '';
  for (const r of chatLog) {
    if (r.role === 'user') addUser(r.text || '', r);
    else {
      const m = el('div', 'msg bot');
      $('messages').appendChild(m);
      renderBot(m, { text: r.text || '', code: r.code || '', meta: r.meta, error: r.error, info: r.info, mode: r.mode, rec: r, notes: r.notes });
    }
  }
  $('welcome').hidden = chatLog.length > 0;
  scrollDown();
}

// ---------- 模式：Notebook / 终端 / 聊天 ----------
const PLACEHOLDERS = {
  notebook: '需要我帮您构建什么？',
  terminal: '想在终端里做什么？例如：下载数据集并解压',
  chat: '有什么问题想问？可以点 + 添加图片或文件'
};
function currentMode() { return normalizeMode(settings && settings.mode); }
function renderMode() {
  const mode = currentMode();
  document.querySelectorAll('.mode-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('selected', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.chips[data-mode]').forEach((c) => { c.hidden = c.dataset.mode !== mode; });
  $('prompt').placeholder = PLACEHOLDERS[mode];
  $('fixError').textContent = mode === 'terminal' ? '修复当前报错（读取终端里最近的输出，给下一步）' : '修复当前报错（读取运行结果，给下一步）';
  document.body.dataset.mode = mode;
  $('plusBtn').title = mode === 'chat' ? '添加图片或文件 / 附带上下文' : '附带上下文 / 修复报错 / 检测硬件';
}
async function setMode(mode) {
  mode = normalizeMode(mode);
  settings.mode = mode; renderMode();
  await saveSettings({ mode });
}

// fix：读取当前单元格（或 opts.run：刚运行完的单元格）的运行结果，让模型给下一步 / 修复
async function send(fix, opts = {}) {
  if (busy) return;
  const request = $('prompt').value.trim();
  let mode = opts.mode ? normalizeMode(opts.mode) : currentMode();
  const atts = !fix && mode === 'chat' ? pendingAtt.slice() : [];
  if (!fix && !request && !atts.length) return;
  if (!fix && /NBAC_HW\s*\{/.test(request)) { // 用户把“检测硬件”的输出贴回来（输出读不到的平台）
    const hw = parseProbeOutput(request);
    addUser(request.slice(0, 300));
    $('prompt').value = ''; autoGrow();
    const m = addThinking();
    if (hw) { await storeProbe(hw); renderBot(m, { error: null, text: '', code: '', info: '已记录硬件：' + hardwareLabel(hw) + '，之后生成的代码会按这个硬件来写' }); }
    else renderBot(m, { error: '没看懂这行 NBAC_HW 输出，请完整复制那一行' });
    return;
  }
  busy = true; $('send').disabled = true; closeMenus(); showNotice('');
  const label = opts.run ? (opts.auto ? '运行出错，自动根据运行结果修复' : '根据运行结果继续') : (mode === 'chat' ? '解释当前报错' : '修复当前报错');
  const shown = fix ? label + (request ? '：' + request : '') : (request || '（发送了附件）');
  const history = llmHistory(); // 在记下这条消息之前取，避免把它自己算进去
  const attMeta = atts.map((a) => ({ kind: a.kind, name: a.name, size: a.size, truncated: !!a.truncated }));
  const uRec = record({ role: 'user', mode, text: shown, attachments: attMeta.length ? attMeta : undefined });
  const convId = uRec.convId;
  addUser(shown, uRec);
  $('prompt').value = ''; autoGrow();
  if (atts.length) { pendingAtt = []; renderAttachments(); }
  const pending = addThinking();
  const setPending = (t) => { const x = pending.querySelector('.thinking-text'); if (x) x.textContent = t; };
  try {
    await refreshSettings();
    const useCtx = settings.includeContext || fix;
    let ctx = { cellCode: '', errorOutput: '', platform: target ? target.platform : '' };
    // 终端模式的「修复当前报错」：用户是自己在终端里运行命令的，读终端里最近的输出（没有终端时才退回读 Notebook 单元格）
    let termOut = null;
    if (fix && mode === 'terminal' && !opts.run) {
      try { termOut = await call('getTerminalOutput', {}); } catch { termOut = null; }
    }
    const termFound = !!(termOut && termOut.found);
    if (useCtx && !termFound) {
      try { ctx = await call('getContext', {}); } catch (e) {
        if (fix && mode === 'terminal') throw new Error('没有找到终端。请在 JupyterLab 里打开一个终端（File → New → Terminal），把命令粘贴进去运行，运行完再点「修复当前报错」。');
        if (fix) throw e;
      }
    }
    if (ctx.notice) showNotice(ctx.notice);
    let extraRequest = request;
    let output = '', isError;
    let lastCommands = '';
    if (fix && termFound) {
      output = termOut.text || request;
      if (!output) throw new Error('终端里还没有读到输出。请先把命令粘贴到终端里运行，运行完再点「修复当前报错」。如果一直读不到，把终端里的输出复制到输入框，再点一次。');
      if (!termOut.text) extraRequest = '';
      const prev = chatLog.slice().reverse().find((x) => x.role === 'bot' && x.mode === 'terminal' && x.code);
      lastCommands = prev ? prev.code : '';
    } else if (fix) {
      const run = opts.run || ctx.run;
      if (opts.run || (run && run.executed && run.output)) { output = run.output || ''; isError = !!run.error; }
      if (!output && !opts.run && ctx.errorOutput) { output = ctx.errorOutput; isError = true; }
      const unreadable = (run && run.unreadable) || ctx.outputUnreadable;
      if (!output && unreadable) {
        // VS Code 网页版（ModelScope、PAI-DSW WebIDE）的输出在跨域 webview 里读不到
        if (request) { output = request; isError = true; extraRequest = ''; }
        else if (run && run.error) {
          const e = await readVsError(setPending);
          setPending('正在思考…');
          if (e && !e.ok && e.text) { output = e.text; isError = true; }
          else if (e && e.ok) throw new Error('读取报错的单元格没有找到上一次的报错（内核里没有记录）。请把报错信息复制到输入框里，再点“修复当前报错”。');
          else throw new Error('自动读取报错没成功（没有读到写回的结果）。请把报错信息复制到输入框里，再点“修复当前报错”。');
        } else if (opts.run) { output = '（这一步运行完成，没有报错；这个平台的输出显示在单独的安全框里，读不到具体输出）'; isError = false; }
        else throw new Error('这个平台的输出显示在单独的安全框里，扩展读不到报错文字。请把报错信息复制到输入框里，再点“修复当前报错”。');
      }
      if (!output) throw new Error('没有找到运行输出。请先运行单元格，并点一下选中它。');
    }
    let userMessage = buildUserMessage({
      request: fix ? (extraRequest ? '（补充说明）' + extraRequest : '') : request,
      cellCode: useCtx && !termFound ? ctx.cellCode : '', errorOutput: fix ? output : (useCtx ? ctx.errorOutput : ''), fix, isError, mode,
      attachments: atts, terminal: termFound, lastCommands
    });
    if (!userMessage.trim()) userMessage = '请看附件。';
    const images = atts.filter((a) => a.kind === 'image');
    const r = await generate(settings, { platform: ctx.platform || (target && target.platform), hardware: pageHw, userMessage, history, mode, images });
    let code = mode === 'chat' ? '' : mode === 'terminal' ? extractShell(r.text) : extractCode(r.text);
    let notes = '';
    if (mode === 'terminal') { const n = normalizeShell(code); code = n.code; notes = n.notes.join('；'); }
    const llm = mode === 'chat' ? r.text : '```' + (mode === 'terminal' ? 'bash' : 'python') + '\n' + code + '```';
    updateRecord(uRec, { llm: userMessage.slice(0, LLM_MAX) });
    const lvl = THINKING_LEVELS.find((l) => l.id === settings.thinking);
    const meta = `${r.providerLabel} · ${r.model}` + (settings.thinking !== 'default' ? ` · 思考：${lvl.label}` : '') +
      (useCtx && !termFound && (ctx.cellCode || ctx.errorOutput || output) ? ' · 已附带上下文' : '') + (images.length ? ` · ${images.length} 张图片` : '') +
      (fix ? (termFound ? ' · 已读取终端输出' : isError === false ? ' · 已读取运行输出' : ' · 已读取报错') : '') + (mode !== 'notebook' ? ` · ${MODE_LABELS[mode]}模式` : '');
    const bRec = record({ role: 'bot', mode, text: r.text, code, meta, notes: notes || undefined, llm: llm.slice(0, LLM_MAX) }, convId);
    renderBot(pending, { text: r.text, code, meta, mode, rec: bRec, notes });
    if (r.notice) showNotice(r.notice);
  } catch (e) {
    const error = String(e.message || e);
    const bRec = record({ role: 'bot', mode, error }, convId);
    renderBot(pending, { error, mode, rec: bRec });
  } finally {
    busy = false; $('send').disabled = false;
  }
}

function autoGrow() { const t = $('prompt'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }


// ---------- 检测硬件：插入一段只读的检测代码，确认后运行，再从输出里读 NBAC_HW 那一行 ----------
async function storeProbe(probe) {
  const hw = mergeHardware(probe, lastHints);
  pageHw = hw;
  if (target) target.hardware = hw;
  await saveProbe(hwKey, probe);
  showHw(hw);
}

function probeHardware() {
  closeMenus();
  $('welcome').hidden = true;
  addUser('检测硬件');
  const m = addThinking();
  const showCell = (prefix) => renderBot(m, {
    text: (prefix || '') + '这段代码只读取硬件信息（显卡型号和显存、CPU 核数、内存、PyTorch 能否用 GPU），不安装任何东西。点「插入并运行」并确认后，我会自动读取结果。',
    code: PROBE_CODE, meta: '内置 · 检测硬件',
    onRan: (setResult) => readProbeResult(setResult)
  });
  // VS Code 网页版（PAI-DSW WebIDE 等）：先试同源的 Jupyter 服务接口开临时内核，成功就不用插单元格
  if (target && target.kind === 'vscode-notebook' && hwKey) {
    const t = target, key = hwKey;
    restProbe(t, key).then((r) => {
      if (r.stale) return;
      if (r.hw) { probeFail = ''; showHw(pageHw); renderBot(m, { info: '已检测硬件（用临时内核在后台运行，没有新建单元格）：' + hardwareLabel(r.hw) + '。之后生成的代码会按这个配置来写。', meta: '内置 · 检测硬件' }); }
      else showCell(r.reason ? '后台检测没成功（' + r.reason + '）。' : '');
    });
    return;
  }
  // JupyterLab：直接在内核里静默检测（内核在忙也不用排队），不新建单元格
  if (target && target.kind === 'jupyterlab' && hwKey) {
    const t = target, key = hwKey;
    silentProbe(t, key).then((r) => {
      if (r.stale) return;
      probeFail = r.hw ? '' : r.reason;
      showHw(pageHw);
      if (r.hw) renderBot(m, { info: '已检测硬件（在后台运行，没有新建单元格）：' + hardwareLabel(r.hw) + '。之后生成的代码会按这个配置来写。', meta: '内置 · 检测硬件' });
      else showCell('后台检测没成功（' + r.reason + '）。');
    });
    return;
  }
  showCell();
}

// 连接后自动检测一次硬件（显卡型号、显存、内存、CPU 核数），结果按网页保存 12 小时
// JupyterLab（Kaggle、安睿云、AI Studio 等）：在已连接的内核里静默运行，不新建单元格
// VS Code 网页版 Notebook（ModelScope）：网页里没有内核接口，只能插入一个只读检测单元格并运行；每个网页 12 小时内最多一次
const HW_TRIED_KEY = 'nbacHwAutoTried2'; // 0.1.9 改了读取方式，换个键让旧的“已试过”记录失效
let autoProbing = false;
const VS_BUSY_POLL_S = 5;
let probeFail = '';
let probeWait = false; // probeFail 只是“在等别的单元格跑完”，不是失败
let probeRunning = false; // 正在后台检测 // 自动检测没成功的原因，显示在硬件那一行
async function autoProbe(t) {
  if (!t || t !== target || autoProbing || !hwKey) return;
  if (t.kind === 'jupyterlab-terminal') return; // 只有终端、没有内核可用：等打开 Notebook 后再检测
  if ((await savedProbe(hwKey))) return;
  const key = hwKey;
  autoProbing = true;
  try {
    if (t.kind === 'jupyterlab') {
      const r = await silentProbe(t, key);
      if (r.stale) return;
      probeFail = r.hw ? '' : r.reason;
      showHw(pageHw);
      return;
    }
    if (t.kind === 'vscode-notebook') {
      // 之前的检测单元格已经把结果写回单元格了：直接读
      try {
        const r0 = await call('readHardwareProbe', {});
        const hw0 = r0 && r0.line ? parseProbeOutput(r0.line) : null;
        if (hw0) { await storeProbe(hw0); return; }
      } catch { /* ignore */ }
      // 先试同源 Jupyter 服务接口开临时内核（PAI-DSW 的 WebIDE 和 JupyterLab 是同一个 Jupyter 服务）：不插单元格，内核在忙也不用等
      const rp = await restProbe(t, key);
      if (rp.stale) return;
      if (rp.hw) { probeFail = ''; return; }
      const pre = rp.reason ? rp.reason + '；' : '';
      const tried = (await chrome.storage.local.get(HW_TRIED_KEY))[HW_TRIED_KEY] || {};
      if (tried[key] && Date.now() - tried[key] < 12 * 3600 * 1000) {
        probeFail = pre + '这个网页 12 小时内已经自动插过一次检测单元格，但没读到结果';
        return;
      }
      // 有单元格正在运行（比如训练）：检测单元格会排在它后面，先等它跑完再插（最多等 6 小时）
      for (let i = 0; i < 6 * 3600 / VS_BUSY_POLL_S; i++) {
        let b = null;
        try { b = await call('notebookBusy', {}); } catch { /* ignore */ }
        if (!(b && b.busy)) break;
        if (hwKey !== key) { probeWait = false; probeFail = ''; return; }
        if (!probeWait) { probeWait = true; probeFail = '有单元格正在运行，这个平台只能插单元格检测，会排在它后面，等它跑完会自动检测'; showHw(pageHw); }
        await new Promise((ok) => setTimeout(ok, VS_BUSY_POLL_S * 1000));
      }
      if (probeWait) { probeWait = false; probeFail = ''; showHw(pageHw); }
      if (hwKey !== key) return;
      tried[key] = Date.now();
      await chrome.storage.local.set({ [HW_TRIED_KEY]: tried });
      showNotice('正在自动检测硬件：在 Notebook 里插入了一个只读的检测单元格并运行（不安装任何东西，检测完可以删掉）。');
      try {
        await call('insertCellBelow', { code: AUTO_PROBE_CODE });
        await call('runCell', {});
      } catch (e) { probeFail = pre + '插入检测单元格失败：' + String(e.message || e).slice(0, 80); showNotice('自动检测硬件没成功：' + e.message + '。可以点「+ → 检测硬件」再试。'); return; }
      const hw = await readProbeResult((msg) => showNotice(msg), true);
      if (hw) { probeFail = ''; showNotice('已自动检测硬件：' + hardwareLabel(hw)); }
      else if (hwKey === key) probeFail = pre + '检测单元格运行了，但没读到写回的结果（内核可能没在运行）';
    }
  } finally {
    autoProbing = false;
    showHw(pageHw);
    // 检测期间切到了别的页面：给新页面补一次自动检测
    if (target && target !== t && hwKey && hwKey !== key) setTimeout(() => autoProbe(target), 0);
  }
}

// JupyterLab：在内核里静默运行检测代码（内核在忙时页面另开临时内核），不新建单元格。返回 {hw} 或 {reason}
async function silentProbe(t, key) {
  probeFail = '';
  probeRunning = true; showHw(pageHw);
  let reason = '';
  try {
    for (let i = 0; i < 4; i++) {
      let r = null;
      try {
        r = await withTimeout(chrome.tabs.sendMessage(t.tabId, { type: 'nbac', action: 'kernelProbe', args: { code: PROBE_CODE, timeoutMs: 120000 }, timeoutMs: 125000 }, { frameId: t.frameId }), 127000);
      } catch (e) { reason = '没有响应（' + String(e && e.message || e).slice(0, 60) + '）'; break; }
      // 检测期间侧边栏可能重新连接了同一个页面（target 换了新对象）：只要还是同一个页面，结果照样用
      if (hwKey !== key) return { stale: true };
      const res = r && r.ok !== false ? (r.result !== undefined ? r.result : r) : null;
      const hw = res && res.output ? parseProbeOutput(res.output) : null;
      if (hw) { probeRunning = false; await storeProbe(hw); return { hw }; }
      reason = !r || r.ok === false ? '出错：' + String(r && r.error || '无返回').slice(0, 80)
        : res.unavailable === 'no-kernel' ? '还没连上内核'
        : res.unavailable === 'busy' ? '内核正在运行别的代码，临时内核也没开起来' + (res.temp ? '（' + res.temp + '）' : '')
        : res.unavailable ? '内核状态 ' + res.unavailable.replace(/^kernel-/, '')
        : '2 分钟内没有输出结果';
      if (!(res && res.unavailable && res.unavailable !== 'busy')) break;
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  } finally { probeRunning = false; }
  return { reason };
}

// VS Code 网页版：通过同源的 Jupyter 服务接口（/api/kernels + WebSocket）开临时内核静默检测，检测完关掉。返回 {hw} / {reason} / {stale}
async function restProbe(t, key) {
  probeRunning = true; showHw(pageHw);
  try {
    let r = null;
    try {
      r = await withTimeout(chrome.tabs.sendMessage(t.tabId, { type: 'nbac', action: 'restProbe', args: { code: PROBE_CODE, timeoutMs: 90000 }, timeoutMs: 100000 }, { frameId: t.frameId }), 105000);
    } catch (e) { return { reason: '临时内核检测没有响应' }; }
    if (hwKey !== key) return { stale: true };
    const res = r && r.ok !== false ? (r.result !== undefined ? r.result : r) : null;
    const hw = res && res.output ? parseProbeOutput(res.output) : null;
    if (hw) { probeRunning = false; await storeProbe(hw); return { hw }; }
    if (!res) return { reason: '临时内核检测出错：' + String(r && r.error || '无返回').slice(0, 60) };
    if (res.unavailable === 'no-jupyter-api') return { reason: '' }; // 这个网站没有 Jupyter 服务接口（ModelScope 免费实例等），只能插单元格
    return { reason: '临时内核没开起来（' + String(res.unavailable || '没有输出').slice(0, 40) + '）' };
  } finally { probeRunning = false; }
}

// waitWriteBack：自动检测会把结果写回单元格文字，输出框读不到也要一直等到结果写回
async function readProbeResult(setResult, waitWriteBack = false) {
  const base = '已插入并运行检测代码';
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let r;
    try { r = await call('readHardwareProbe', {}); } catch { continue; }
    const hw = r && r.line ? parseProbeOutput(r.line) : null;
    if (hw) { await storeProbe(hw); setResult(base + '。硬件：' + hardwareLabel(hw) + '（之后生成的代码会按这个硬件来写）'); return hw; }
    if (r && r.unreadable && i >= (waitWriteBack ? 44 : 4)) {
      setResult(base + '。这个平台的输出在单独的安全框里，扩展读不到：请把输出里以 NBAC_HW 开头的那一行复制到输入框发给我');
      return null;
    }
  }
  setResult(base + '，但 90 秒内没读到结果。运行完后可以把输出里 NBAC_HW 那一行复制到输入框发给我', true);
  return null;
}

// ---------- 诊断信息：每个 frame 的结构信息（不含代码、输出和 Key），复制到剪贴板 ----------
async function copyDiagnostics() {
  closeMenus();
  showNotice('正在收集诊断信息…');
  const tabId = await activeTabId();
  const reports = tabId ? await collectReports(tabId, 1500, 'diagnose', 'nbac-diag') : [];
  let tab = null;
  try { tab = tabId ? await chrome.tabs.get(tabId) : null; } catch { /* ignore */ }
  const data = {
    tool: 'Notebook AI Copilot', version: chrome.runtime.getManifest().version, at: new Date().toISOString(),
    userAgent: navigator.userAgent, tabUrl: tab && tab.url ? tab.url.split(/[?#]/)[0] : null,
    target: target ? { frameId: target.frameId, platform: target.platform, kind: target.kind } : null,
    status: $('status').textContent.slice(0, 200), lastPanelError,
    hardware: pageHw, probeFail: probeFail || null, inject: tabId ? injectState.get(tabId) || null : null,
    permissions: await chrome.permissions.getAll().then((p) => ({ permissions: p.permissions, origins: p.origins })).catch((e) => String(e)),
    registeredScripts: await chrome.scripting.getRegisteredContentScripts().then((l) => l.map((x) => ({ id: x.id, matches: x.matches }))).catch(() => null),
    frames: reports.sort((a, b) => a.frameId - b.frameId).map((r) => ({ frameId: r.frameId, ...r.frame }))
  };
  const text = JSON.stringify(data, null, 1);
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    t.remove();
  }
  const box = $('diagOutput');
  box.value = text; box.hidden = copied;
  showNotice(copied ? `诊断信息已复制到剪贴板（${data.frames.length} 个 frame，${text.length} 字），直接粘贴发给开发者即可。不含代码、输出和 API Key。`
    : '复制失败：诊断信息在下面的框里，请全选后手动复制。');
  return data;
}

// ---------- 事件 ----------
$('send').addEventListener('click', () => send(false));
$('prompt').addEventListener('input', autoGrow);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
});
document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  if (c.dataset.action === 'fix') return send(true);
  $('prompt').value = c.dataset.prompt; autoGrow(); $('prompt').focus();
}));
$('plusBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('plusMenu'); });
$('thinkBtn').addEventListener('click', (e) => { e.stopPropagation(); if (toggleMenu('thinkMenu')) renderThinkMenu(); });
$('modelBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (toggleMenu('modelMenu')) { renderProviderSelect(); $('modelInput').value = cur().model; loadModelList(false); }
});
for (const id of ['plusMenu', 'thinkMenu', 'modelMenu']) $(id).addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeMenus());
$('includeContext').addEventListener('change', async (e) => { await saveSettings({ includeContext: e.target.checked }); await refreshSettings(); });
$('fixError').addEventListener('click', () => send(true));
$('refresh').addEventListener('click', () => { closeMenus(); detect(); });
$('diagnose').addEventListener('click', () => { copyDiagnostics(); });
$('probeHw').addEventListener('click', () => probeHardware());
$('enableSite').addEventListener('click', () => { if (siteAccessOrigins) enableSite(siteAccessOrigins); });
if (forcedTabId) window.enableSiteForTest = (origins) => enableSite(origins, true); // 测试用：自动化里没法点 Chrome 的权限弹窗
if (forcedTabId) window.copyDiagnosticsForTest = copyDiagnostics; // 测试用
$('providerSelect').addEventListener('change', async (e) => {
  await saveSettings({ active: e.target.value });
  await refreshSettings();
  $('modelInput').value = cur().model;
  loadModelList(false);
});
$('refreshModels').addEventListener('click', () => loadModelList(true));
$('modelInput').addEventListener('input', () => {
  const cache = settings.modelCache[settings.active];
  renderModelList(cache ? cache.models : [], $('modelHint').textContent, $('modelHint').classList.contains('err'));
});
$('modelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chooseModel($('modelInput').value); } });
$('modelInput').addEventListener('change', () => chooseModel($('modelInput').value));
// 新对话 = 清空全部聊天记录（先确认）；没有记录时直接回到欢迎页
$('newChat').addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); newConversation(); });
$('historyBtn').addEventListener('click', (e) => { e.stopPropagation(); if ($('convDrawer').hidden) openDrawer(); else closeDrawer(); });
$('drawerMask').addEventListener('click', () => closeDrawer());
$('convClose').addEventListener('click', () => closeDrawer());
$('convNew').addEventListener('click', () => newConversation());
$('convDeleteAll').addEventListener('click', () => { $('convAllConfirm').hidden = false; });
$('convAllNo').addEventListener('click', () => { $('convAllConfirm').hidden = true; });
$('convAllYes').addEventListener('click', () => { $('convAllConfirm').hidden = true; deleteAllConversations(); });
$('convDrawer').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('convDrawer').hidden) closeDrawer(); });
// 聊天模式：+ → 添加图片或文件；也可以直接粘贴图片、把文件拖进输入框
$('attachFile').addEventListener('click', () => { closeMenus(); $('fileInput').click(); });
$('fileInput').addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
$('prompt').addEventListener('paste', (e) => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length || currentMode() !== 'chat') return;
  e.preventDefault(); addFiles(files);
});
$('composer').addEventListener('dragover', (e) => { if (currentMode() === 'chat') { e.preventDefault(); $('composer').classList.add('drag'); } });
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('drag'));
$('composer').addEventListener('drop', (e) => {
  $('composer').classList.remove('drag');
  if (currentMode() !== 'chat' || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); addFiles(e.dataTransfer.files);
});
$('autoFix').addEventListener('change', async (e) => { await saveSettings({ autoFix: e.target.checked }); await refreshSettings(); });
if (forcedTabId) window.addFilesForTest = addFiles; // 测试用
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('closePanel').addEventListener('click', () => window.close());

chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') refreshSettings(); });
if (!forcedTabId) {
  chrome.tabs.onActivated.addListener(() => detect());
  chrome.tabs.onUpdated.addListener(async (id, info) => { if (info.status !== 'complete') return; if ((target && id === target.tabId) || id === await activeTabId()) detect(); });
}

Promise.all([refreshSettings(), loadChat()]).then(() => { renderMode(); renderChatLog(); detect(); });
