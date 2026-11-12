import {
  PRESETS, PROVIDER_IDS, THINKING_LEVELS, loadSettings, saveSettings, updateProvider,
  supportedThinking, listModels, generate, buildUserMessage, extractCode
} from '../lib/llm.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// 测试用：?tabId=123 可以把面板当普通页面打开并指定目标标签页
const forcedTabId = params.has('tabId') ? Number(params.get('tabId')) : null;

let target = null; // {tabId, frameToken, platform, kind}
let busy = false;
let history = []; // [{role, content}]
let settings = null;

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

async function detect() {
  target = null;
  setStatus('正在检测当前页面的 Notebook…');
  const tabId = await activeTabId();
  if (!tabId) { setStatus('没有找到当前标签页', 'bad'); return null; }
  try {
    const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'nbac', action: 'detect' }), 4000);
    if (r && r.ok) {
      target = { tabId, frameToken: r.frameToken, platform: r.platform, kind: r.kind };
      setStatus(`已连接：${r.platform}（${r.kind}${r.viaApp ? '，JupyterLab API' : ''}）`, 'ok');
      return target;
    }
  } catch { /* 没有 frame 回复 */ }
  setStatus('没有检测到 Notebook：打开 AI Studio / ModelScope / Kaggle 的 Notebook，加载完后点“+ → 重新检测”', 'bad');
  return null;
}

async function call(action, args) {
  if (!target) await detect();
  if (!target) throw new Error('未连接到 Notebook');
  const send = () => chrome.tabs.sendMessage(target.tabId, { type: 'nbac', action, args, frameToken: target.frameToken });
  let r;
  try { r = await send(); } catch (e) {
    await detect();
    if (!target) throw e;
    r = await send();
  }
  if (!r) throw new Error('页面没有响应');
  if (!r.ok) throw new Error(r.error || '操作失败');
  return r.result;
}

// ---------- 设置：服务商 / 模型 / 思考强度 ----------
async function refreshSettings() { settings = await loadSettings(); renderBar(); }
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

function addUser(text) {
  $('welcome').hidden = true;
  const m = el('div', 'msg user');
  const b = el('div', 'bubble'); b.textContent = text;
  m.appendChild(b);
  $('messages').appendChild(m);
  scrollDown();
}

function addThinking() {
  const m = el('div', 'msg bot pending', '<div class="thinking"><span class="dot"></span>正在思考…</div>');
  $('messages').appendChild(m);
  scrollDown();
  return m;
}

function renderBot(m, { text, code, meta, error }) {
  m.className = 'msg bot' + (error ? ' err' : '');
  m.innerHTML = '';
  if (meta) m.appendChild(el('div', 'meta', escapeHtml(meta)));
  if (error) { m.appendChild(el('div', 'text', escapeHtml(error))); return; }
  const outside = text.replace(/```[\s\S]*?```/g, '').trim();
  if (outside) m.appendChild(el('div', 'text', escapeHtml(outside.slice(0, 600))));
  const block = el('div', 'codeblock');
  block.appendChild(el('div', 'lang', 'Python · 可直接修改后再插入'));
  const ta = el('textarea'); ta.spellcheck = false; ta.value = code;
  ta.rows = Math.min(22, Math.max(4, code.split('\n').length + 1));
  block.appendChild(ta);
  m.appendChild(block);
  const acts = el('div', 'code-actions');
  const bCopy = el('button', 'act act-copy', ICON.copy + '复制');
  const bIns = el('button', 'act primary act-insert', ICON.insert + '插入到新单元格');
  const bRun = el('button', 'act danger act-run', ICON.run + '插入并运行');
  acts.append(bCopy, bIns, bRun);
  m.appendChild(acts);
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  confirm.innerHTML = '确认把这段代码插入到当前单元格下方并<strong>立即运行</strong>吗？';
  const cActs = el('div', 'code-actions');
  const bOk = el('button', 'act danger act-confirm', ICON.run + '确认运行');
  const bNo = el('button', 'act act-cancel', '取消');
  cActs.append(bOk, bNo); confirm.appendChild(cActs);
  m.appendChild(confirm);
  const result = el('div', 'result');
  m.appendChild(result);

  const setResult = (t, err) => { result.textContent = t; result.className = 'result' + (err ? ' err' : ''); };
  bCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
    setResult('已复制');
  });
  const doInsert = async (andRun) => {
    if (!ta.value.trim()) { setResult('没有可插入的代码', true); return; }
    for (const b of [bIns, bRun, bOk]) b.disabled = true;
    try {
      const r = await call('insertCellBelow', { code: ta.value });
      if (andRun) { await call('runCell', {}); setResult(`已插入新单元格并开始运行（${r.via}）`); }
      else setResult(`已插入到新单元格（${r.via}），检查无误后在 Notebook 里运行`);
    } catch (e) { setResult('插入失败：' + (e.message || e), true); }
    finally { for (const b of [bIns, bRun, bOk]) b.disabled = false; confirm.hidden = true; }
  };
  bIns.addEventListener('click', () => doInsert(false));
  bRun.addEventListener('click', () => { confirm.hidden = false; scrollDown(); });
  bNo.addEventListener('click', () => { confirm.hidden = true; });
  bOk.addEventListener('click', () => doInsert(true));
  scrollDown();
}

async function send(fix) {
  if (busy) return;
  const request = $('prompt').value.trim();
  if (!fix && !request) return;
  busy = true; $('send').disabled = true; closeMenus(); showNotice('');
  addUser(fix ? '修复当前报错' + (request ? '：' + request : '') : request);
  $('prompt').value = ''; autoGrow();
  const pending = addThinking();
  try {
    await refreshSettings();
    const useCtx = settings.includeContext || fix;
    let ctx = { cellCode: '', errorOutput: '', platform: target ? target.platform : '' };
    if (useCtx) {
      try { ctx = await call('getContext', {}); } catch (e) { if (fix) throw e; }
    }
    if (fix && !ctx.errorOutput) throw new Error('没有找到报错输出。请先运行出错的单元格，并点一下选中它。');
    const userMessage = buildUserMessage({
      request: fix ? (request ? '（补充说明）' + request : '') : request,
      cellCode: useCtx ? ctx.cellCode : '', errorOutput: useCtx ? ctx.errorOutput : '', fix
    });
    const r = await generate(settings, { platform: ctx.platform || (target && target.platform), userMessage, history: history.slice(-6) });
    const code = extractCode(r.text);
    history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: '```python\n' + code + '```' });
    const lvl = THINKING_LEVELS.find((l) => l.id === settings.thinking);
    renderBot(pending, { text: r.text, code, meta: `${r.providerLabel} · ${r.model}` + (settings.thinking !== 'default' ? ` · 思考：${lvl.label}` : '') + (useCtx && (ctx.cellCode || ctx.errorOutput) ? ' · 已附带上下文' : '') });
    if (r.notice) showNotice(r.notice);
  } catch (e) {
    renderBot(pending, { error: String(e.message || e) });
  } finally {
    busy = false; $('send').disabled = false;
  }
}

function autoGrow() { const t = $('prompt'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }

// ---------- 事件 ----------
$('send').addEventListener('click', () => send(false));
$('prompt').addEventListener('input', autoGrow);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
});
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
$('newChat').addEventListener('click', () => { history = []; $('messages').innerHTML = ''; $('welcome').hidden = false; showNotice(''); });
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('closePanel').addEventListener('click', () => window.close());

chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') refreshSettings(); });
if (!forcedTabId) {
  chrome.tabs.onActivated.addListener(() => detect());
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' && target && id === target.tabId) detect(); });
}

refreshSettings().then(detect);
