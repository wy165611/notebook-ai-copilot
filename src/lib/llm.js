// 模型调用、模型列表、思考强度映射。
// API Key 只从 chrome.storage.local 读取，不写日志、不同步。

// ---------- 服务商预设 ----------
export const PRESETS = {
  bailian: {
    label: '阿里云百炼', kind: 'openai', flavor: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'deepseek-v4.1-flash',
    suggestions: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4-pro', 'qwen3.8-max', 'qwen4-max-preview', 'kimi-k3', 'glm-5.3'],
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key'
  },
  deepseek: {
    label: 'DeepSeek 官方', kind: 'openai', flavor: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    suggestions: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  gemini: {
    label: 'Google Gemini', kind: 'gemini', flavor: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash',
    suggestions: ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  custom: {
    label: '自定义（OpenAI 兼容）', kind: 'openai', flavor: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    suggestions: [],
    keyUrl: ''
  }
};
export const PROVIDER_IDS = Object.keys(PRESETS);

export const DEFAULTS = {
  active: 'bailian',
  thinking: 'max',
  includeContext: true,
  temperature: 0.2,
  providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { baseUrl: PRESETS[id].baseUrl, apiKey: '', model: PRESETS[id].model }])),
  modelCache: {}
};

export async function loadSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = { ...DEFAULTS, ...s };
  out.providers = {};
  for (const id of PROVIDER_IDS) out.providers[id] = { ...DEFAULTS.providers[id], ...((s.providers || {})[id] || {}) };
  if (!PRESETS[out.active]) out.active = 'bailian';
  out.modelCache = s.modelCache || {};
  return out;
}

export async function saveSettings(patch) { await chrome.storage.local.set(patch); }

export async function updateProvider(id, patch) {
  const s = await loadSettings();
  s.providers[id] = { ...s.providers[id], ...patch };
  await chrome.storage.local.set({ providers: s.providers });
  return s.providers[id];
}

// ---------- 思考强度 ----------
export const THINKING_LEVELS = [
  { id: 'default', label: '默认' },
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' }
];

// 返回该模型支持的档位（'default' 永远可用：表示不传任何思考参数）
export function supportedThinking(providerId, model) {
  const flavor = PRESETS[providerId].flavor;
  const m = String(model || '').toLowerCase();
  if (flavor === 'deepseek') return ['default', 'off', 'low', 'high', 'max'];
  if (flavor === 'dashscope') {
    if (m.startsWith('deepseek-v4')) return ['default', 'off', 'low', 'high', 'max'];
    if (m.startsWith('qwen')) return ['default', 'off', 'low', 'medium', 'high', 'max'];
    if (m.startsWith('kimi') || m.startsWith('glm') || m.startsWith('deepseek')) return ['default', 'off', 'high'];
    return ['default', 'off', 'high'];
  }
  if (flavor === 'gemini') {
    if (/gemini-2\.5/.test(m)) return ['default', 'off', 'low', 'medium', 'high', 'max'];
    if (/gemini-3\.8/.test(m)) return ['default', 'low', 'medium', 'high']; // 3.8 Flash 不支持 minimal
    return ['default', 'off', 'low', 'medium', 'high'];
  }
  return ['default', 'low', 'medium', 'high'];
}

// 把档位映射成各家真实的请求参数（合并进请求体）
export function thinkingParams(providerId, model, level) {
  if (!level || level === 'default') return {};
  if (!supportedThinking(providerId, model).includes(level)) return {};
  const flavor = PRESETS[providerId].flavor;
  const m = String(model || '').toLowerCase();
  if (flavor === 'deepseek') {
    // DeepSeek 官方：thinking.type + reasoning_effort（low/high/max）
    if (level === 'off') return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'enabled' }, reasoning_effort: level };
  }
  if (flavor === 'dashscope') {
    if (level === 'off') return { enable_thinking: false };
    if (m.startsWith('deepseek-v4')) return { enable_thinking: true, reasoning_effort: level };
    if (m.startsWith('qwen')) {
      const budget = { low: 1024, medium: 4096, high: 16384 }[level];
      return budget ? { enable_thinking: true, thinking_budget: budget } : { enable_thinking: true };
    }
    return { enable_thinking: true };
  }
  if (flavor === 'gemini') {
    if (/gemini-2\.5/.test(m)) {
      const b = { off: 0, low: 1024, medium: 4096, high: 16384, max: -1 }[level];
      return { thinkingConfig: { thinkingBudget: b } };
    }
    return { thinkingConfig: { thinkingLevel: level === 'off' ? 'minimal' : level } };
  }
  return { reasoning_effort: level }; // 标准 OpenAI 风格
}

// ---------- 提示词 ----------
export function systemPrompt(platform) {
  const china = /AI Studio|ModelScope/.test(platform || '');
  return [
    `你是运行在 ${platform || 'Jupyter'} Notebook 里的编程助手。`,
    '规则：',
    '1. 只输出一个可以直接运行的 Python 代码单元格，放在唯一一个 ```python 代码块里；代码块外最多写一两句话说明。',
    '2. 安装依赖用 %pip install（不要用 !pip），装完需要时提示重启内核。',
    china
      ? '3. 这是国内平台，pip 安装请加清华镜像：%pip install <包> -i https://pypi.tuna.tsinghua.edu.cn/simple ；从 Hugging Face 下载时优先用 HF_ENDPOINT=https://hf-mirror.com。'
      : '3. 这是海外平台，正常使用 PyPI 即可。',
    '4. 代码要完整、可重复运行（已存在的文件/目录要能跳过），关键步骤用简短中文注释。',
    '5. 如果用户给了报错信息，输出修好后的完整单元格，而不是只给片段。',
    '6. 不要编造路径；不确定的路径用变量写在开头，方便用户修改。'
  ].join('\n');
}

export function buildUserMessage({ request, cellCode, errorOutput, fix }) {
  const parts = [];
  if (fix) parts.push('请修复下面这个单元格的报错，输出修好后的完整单元格。');
  if (request) parts.push('需求：' + request);
  if (cellCode) parts.push('当前单元格代码：\n```python\n' + cellCode.slice(0, 8000) + '\n```');
  if (errorOutput) parts.push('最近的报错输出：\n```\n' + errorOutput.slice(-4000) + '\n```');
  return parts.join('\n\n');
}

export function extractCode(text) {
  if (!text) return '';
  const m = text.match(/```(?:python|py|ipython)?[^\n]*\n([\s\S]*?)```/i);
  if (m) return m[1].replace(/\s+$/, '') + '\n';
  return text.trim() + '\n';
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

// 把 HTTP 错误翻译成看得懂的中文
export function explainError(status, message, model) {
  const msg = message || '';
  if (status === 401) return `API Key 无效或已过期（401）：${msg}`;
  if (status === 403) return `没有权限使用模型 ${model}（403）：${msg}。这个模型可能已下线，或你的账号无权调用，请换一个模型。`;
  if (status === 400 && /not.?activ|未开通|not.?enabled|开通/i.test(msg)) return `模型 ${model} 在你的账号下还没有开通（400）：${msg}。请到控制台开通，或换一个模型。`;
  if (status === 404) return `找不到模型或接口（404）：${msg}。请检查模型 ID 和接口地址。`;
  if (status === 429) return `请求太频繁或额度用完（429）：${msg}`;
  return `接口返回 ${status}：${msg}`;
}

class ApiError extends Error {
  constructor(status, message, model) { super(explainError(status, message, model)); this.status = status; this.raw = message; }
}

function errMessage(data, res) {
  return (data && data.error && (data.error.message || data.error.code)) || (data && data.message) || res.statusText || '';
}

// ---------- 模型列表 ----------
const NON_CHAT = /(asr|tts|audio|speech|paraformer|sensevoice|cosyvoice|sambert|embed|rerank|image|wanx|wan2|flux|stable-diffusion|video|ocr-|realtime|transcri|aqa|imagen|veo|-live)/i;

export function filterChatModels(ids) {
  return ids.filter((id) => !NON_CHAT.test(id));
}

export async function listModels(providerId, cfg) {
  const p = PRESETS[providerId];
  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  if (p.kind === 'gemini') {
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/models?pageSize=1000`, { headers: { 'x-goog-api-key': cfg.apiKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, errMessage(data, res), '');
    const ids = (data.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''));
    return filterChatModels(ids).sort();
  }
  const res = await fetch(`${trimSlash(cfg.baseUrl)}/models`, { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, errMessage(data, res), '');
  const ids = (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  return filterChatModels(ids).sort();
}

// ---------- 生成 ----------
// history: [{role:'user'|'assistant', content}]
export async function generate(settings, { platform, userMessage, history = [], signal }) {
  const id = settings.active;
  const p = PRESETS[id];
  const cfg = settings.providers[id];
  const model = cfg.model;
  if (!cfg.apiKey) throw new Error(`请先在设置里填写「${p.label}」的 API Key`);
  if (!model) throw new Error('请先选择或输入模型 ID');
  const sys = systemPrompt(platform);
  const think = thinkingParams(id, model, settings.thinking);
  const temperature = Number(settings.temperature) || 0.2;

  async function once(withThinking) {
    if (p.kind === 'gemini') {
      const genCfg = { temperature };
      if (withThinking && think.thinkingConfig) genCfg.thinkingConfig = think.thinkingConfig;
      const contents = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
      contents.push({ role: 'user', parts: [{ text: userMessage }] });
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: genCfg })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, errMessage(data, res), model);
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      return parts.filter((x) => !x.thought && typeof x.text === 'string').map((x) => x.text).join('');
    }
    const body = {
      model,
      messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: userMessage }],
      stream: false
    };
    // 思考模式下很多模型不接受 temperature，开启思考时不传
    if (!withThinking || !Object.keys(think).length || settings.thinking === 'off') body.temperature = temperature;
    if (withThinking) Object.assign(body, think);
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, errMessage(data, res), model);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return (msg && msg.content) || '';
  }

  let notice = '';
  let text;
  const hasThink = Object.keys(think).length > 0;
  try {
    text = await once(true);
  } catch (e) {
    // 服务商拒绝思考参数（400 且不是“未开通”）→ 去掉参数重试一次
    if (hasThink && e.status === 400 && !/not.?activ|未开通|开通/i.test(e.raw || '')) {
      text = await once(false);
      notice = '这个模型不接受所选的思考强度参数，已改用默认方式重新生成。';
    } else throw e;
  }
  if (!text) throw new Error('模型没有返回内容');
  return { text, notice, model, providerLabel: p.label };
}
