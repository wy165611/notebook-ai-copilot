import { PRESETS, PROVIDER_IDS, DEFAULTS, loadSettings } from '../lib/llm.js';

const $ = (id) => document.getElementById(id);
const NOTES = {
  bailian: '默认模型 deepseek-v4.1-flash（DeepSeek-V4.1-Flash 最新版 1017）。同一个 Key 还能用 qwen3.8-max、kimi-k3、glm-5.3 等；带 “/” 的第三方模型需要先在百炼控制台开通。',
  deepseek: '官方接口地址是 https://api.deepseek.com，模型名 deepseek-flash 目前由 DeepSeek-V4.1-Flash-1017 提供。',
  gemini: '默认 gemini-3.5-flash。Google 已把 3.5 Flash 标为弃用，请求会自动转到 gemini-3.6-flash；国内网络通常无法直连。',
  custom: '任意 OpenAI 兼容接口（填到 /v1 为止）。保存时 Chrome 会请求访问该网站的权限。'
};

const EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53a5 5 0 0 1-5-5c0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01z"/></svg>';

function msg(t, err) { $('message').textContent = t; $('message').className = err ? 'err' : ''; }

function syncActiveCard() {
  const active = $('active').value;
  for (const el of document.querySelectorAll('.card[data-provider]')) {
    const isAct = el.dataset.provider === active;
    el.classList.toggle('active-card', isAct);
    const badge = el.querySelector('.default-tag');
    if (badge) badge.hidden = !isAct;
  }
}

function syncChips(cardEl, modelValue) {
  for (const ch of cardEl.querySelectorAll('.sug-chip')) {
    ch.classList.toggle('active', ch.dataset.model === modelValue.trim());
  }
}

function syncKeyStatus(cardEl, keyVal) {
  const badge = cardEl.querySelector('.key-status');
  if (!badge) return;
  const ok = !!String(keyVal || '').trim();
  badge.textContent = ok ? '已配置' : '未配置';
  badge.classList.toggle('configured', ok);
}

function card(id, cfg) {
  const p = PRESETS[id];
  const d = document.createElement('div');
  d.className = 'card';
  d.dataset.provider = id;
  d.innerHTML = `
    <h3>
      <span>${p.label}</span>
      <span class="card-badges">
        <span class="tag key-status"></span>
        <span class="tag default-tag" hidden>当前默认</span>
        ${id === 'bailian' ? '<span class="tag">推荐</span>' : ''}
      </span>
    </h3>
    <label for="key-${id}"><span>API Key</span>${p.keyUrl ? `<a href="${p.keyUrl}" target="_blank" rel="noopener">在这里创建 ↗</a>` : ''}</label>
    <div class="input-wrap">
      <input id="key-${id}" type="password" autocomplete="off" placeholder="粘贴你的 API Key" data-p="${id}" data-f="apiKey" />
      <button type="button" class="toggle-eye" aria-label="显示或隐藏 API Key" title="显示或隐藏 API Key">${EYE_OPEN}</button>
    </div>
    <label for="url-${id}">接口地址 Base URL</label>
    <input id="url-${id}" type="text" data-p="${id}" data-f="baseUrl" />
    <label for="model-${id}">默认模型 ID（侧边栏里可随时切换）</label>
    <input id="model-${id}" type="text" data-p="${id}" data-f="model" list="sug-${id}" />
    <datalist id="sug-${id}">${p.suggestions.map((s) => `<option value="${s}"></option>`).join('')}</datalist>
    ${p.suggestions.length ? `<div class="sug-chips">${p.suggestions.map((s) => `<button type="button" class="sug-chip" data-model="${s}">${s}</button>`).join('')}</div>` : ''}
    <p class="hint">${NOTES[id]}</p>`;
  for (const inp of d.querySelectorAll('input')) inp.value = cfg[inp.dataset.f] || '';

  const keyInput = d.querySelector('input[data-f="apiKey"]');
  syncKeyStatus(d, keyInput.value);
  keyInput.addEventListener('input', () => syncKeyStatus(d, keyInput.value));
  const eyeBtn = d.querySelector('.toggle-eye');
  eyeBtn.addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    eyeBtn.innerHTML = show ? EYE_OFF : EYE_OPEN;
  });

  const modelInput = d.querySelector('input[data-f="model"]');
  syncChips(d, modelInput.value);
  modelInput.addEventListener('input', () => syncChips(d, modelInput.value));
  for (const ch of d.querySelectorAll('.sug-chip')) {
    ch.addEventListener('click', () => {
      modelInput.value = ch.dataset.model;
      syncChips(d, modelInput.value);
    });
  }
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
  syncActiveCard();
}

$('active').addEventListener('change', syncActiveCard);

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
    for (const el of document.querySelectorAll('.card[data-provider]')) syncKeyStatus(el, providers[el.dataset.provider].apiKey);
    msg(denied.length ? `已保存，但没有授权访问：${denied.join('、')}，调用可能失败。` : '已保存。', denied.length > 0);
  } catch (e) { msg(String(e.message || e), true); }
});

$('clearKeys').addEventListener('click', async () => {
  const s = await loadSettings();
  for (const id of PROVIDER_IDS) s.providers[id].apiKey = '';
  await chrome.storage.local.set({ providers: s.providers, modelCache: {} });
  for (const inp of document.querySelectorAll('input[data-f="apiKey"]')) inp.value = '';
  for (const el of document.querySelectorAll('.card[data-provider]')) syncKeyStatus(el, '');
  msg('已清除。');
});

init();
