import { PRESETS, PROVIDER_IDS, DEFAULTS, loadSettings } from '../lib/llm.js';

const $ = (id) => document.getElementById(id);
const NOTES = {
  bailian: '默认模型 deepseek-v4.1-flash（DeepSeek-V4.1-Flash 最新版 1017）。同一个 Key 还能用 qwen3.8-max、kimi-k3、glm-5.3 等；带 “/” 的第三方模型需要先在百炼控制台开通。',
  deepseek: '官方接口地址是 https://api.deepseek.com，模型名 deepseek-flash 目前由 DeepSeek-V4.1-Flash-1017 提供。',
  gemini: '默认 gemini-3.5-flash。Google 已把 3.5 Flash 标为弃用，请求会自动转到 gemini-3.6-flash；国内网络通常无法直连。',
  custom: '任意 OpenAI 兼容接口（填到 /v1 为止）。保存时 Chrome 会请求访问该网站的权限。'
};

function msg(t, err) { $('message').textContent = t; $('message').className = err ? 'err' : ''; }

function card(id, cfg) {
  const p = PRESETS[id];
  const d = document.createElement('div');
  d.className = 'card';
  d.innerHTML = `
    <h3>${p.label} ${id === 'bailian' ? '<span class="tag">推荐</span>' : ''}</h3>
    <label>API Key ${p.keyUrl ? `（<a href="${p.keyUrl}" target="_blank" rel="noopener">在这里创建</a>）` : ''}</label>
    <input type="password" autocomplete="off" data-p="${id}" data-f="apiKey" />
    <label>接口地址 Base URL</label>
    <input type="text" data-p="${id}" data-f="baseUrl" />
    <label>默认模型 ID（侧边栏里可随时切换）</label>
    <input type="text" data-p="${id}" data-f="model" list="sug-${id}" />
    <datalist id="sug-${id}">${p.suggestions.map((s) => `<option value="${s}"></option>`).join('')}</datalist>
    <p class="hint">${NOTES[id]}</p>`;
  for (const inp of d.querySelectorAll('input')) inp.value = cfg[inp.dataset.f] || '';
  return d;
}

async function ensureHostPermission(url) {
  let origin;
  try { origin = new URL(url).origin + '/*'; } catch { throw new Error('接口地址格式不对：' + url); }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function init() {
  const s = await loadSettings();
  $('active').innerHTML = PROVIDER_IDS.map((id) => `<option value="${id}">${PRESETS[id].label}</option>`).join('');
  $('active').value = s.active;
  const cards = $('cards');
  cards.innerHTML = '';
  for (const id of PROVIDER_IDS) cards.appendChild(card(id, s.providers[id]));
  $('temperature').value = s.temperature;
}

$('save').addEventListener('click', async () => {
  const s = await loadSettings();
  const providers = JSON.parse(JSON.stringify(s.providers));
  for (const inp of document.querySelectorAll('input[data-p]')) providers[inp.dataset.p][inp.dataset.f] = inp.value.trim();
  for (const id of PROVIDER_IDS) {
    if (!providers[id].baseUrl) providers[id].baseUrl = PRESETS[id].baseUrl;
    if (!providers[id].model) providers[id].model = PRESETS[id].model;
  }
  const temperature = Math.min(1, Math.max(0, Number($('temperature').value) || DEFAULTS.temperature));
  try {
    const denied = [];
    // 自定义/改过的地址需要额外授权（内置的百炼、DeepSeek、Gemini 已在 manifest 中声明）
    for (const id of PROVIDER_IDS) {
      if (!providers[id].apiKey) continue;
      if (providers[id].baseUrl === PRESETS[id].baseUrl && id !== 'custom') continue;
      if (!(await ensureHostPermission(providers[id].baseUrl))) denied.push(PRESETS[id].label);
    }
    // 地址或 Key 变了的服务商，清掉模型列表缓存
    const modelCache = { ...s.modelCache };
    for (const id of PROVIDER_IDS) {
      if (providers[id].baseUrl !== s.providers[id].baseUrl || providers[id].apiKey !== s.providers[id].apiKey) delete modelCache[id];
    }
    await chrome.storage.local.set({ providers, active: $('active').value, temperature, modelCache });
    msg(denied.length ? `已保存，但没有授权访问：${denied.join('、')}，调用可能失败。` : '已保存。', denied.length > 0);
  } catch (e) { msg(String(e.message || e), true); }
});

$('clearKeys').addEventListener('click', async () => {
  const s = await loadSettings();
  for (const id of PROVIDER_IDS) s.providers[id].apiKey = '';
  await chrome.storage.local.set({ providers: s.providers, modelCache: {} });
  for (const inp of document.querySelectorAll('input[data-f="apiKey"]')) inp.value = '';
  msg('已清除。');
});

init();
