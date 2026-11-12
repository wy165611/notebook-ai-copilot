// 模型调用、模型列表、思考强度映射。
// API Key 只从 chrome.storage.local 读取，不写日志、不同步。
import { hardwareRule } from './hardware.js';

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
  autoFix: false, // 运行出错后自动根据运行结果生成修复代码（只生成，不会自动运行）
  mode: 'notebook', // 侧边栏模式：notebook（写单元格）/ terminal（终端命令）/ chat（聊天问答）
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
export const MODES = ['notebook', 'terminal', 'chat'];
export const MODE_LABELS = { notebook: 'Notebook', terminal: '终端', chat: '聊天' };
export function normalizeMode(mode) { return MODES.includes(mode) ? mode : 'notebook'; }
function isChinaPlatform(platform) { return /AI Studio|ModelScope|安睿云/.test(platform || ''); }

export function systemPrompt(platform, hardware, mode = 'notebook') {
  mode = normalizeMode(mode);
  const china = isChinaPlatform(platform);
  if (mode === 'terminal') {
    return [
      `你是 ${platform || 'Jupyter'} 上的终端（bash）助手，用户会把你给的命令粘贴到这个平台的终端里运行（或者放进 Notebook 的 %%bash 单元格里运行）。`,
      '规则：',
      '1. 只输出一个 ```bash 代码块，里面是可以按顺序直接运行的 shell 命令；代码块外最多写一两句话说明。不要输出 Python 单元格，不要用 %pip / ! 这类 Notebook 魔法命令。',
      '2. 命令必须是非交互的：apt-get / conda 加 -y，pip 加 -q 或 --no-input，解压加 -o 覆盖确认等，不要写需要人工输入的步骤；耗时很长的任务用 nohup … > xxx.log 2>&1 & 放到后台并说明怎么看日志。',
      china
        ? '3. 这是国内平台：pip 安装加清华镜像 pip install <包> -i https://pypi.tuna.tsinghua.edu.cn/simple ；从 Hugging Face 下载前先 export HF_ENDPOINT=https://hf-mirror.com（huggingface-cli / hf download 都走这个镜像）。'
        : '3. 这是海外平台，正常使用 PyPI 和 Hugging Face 即可。',
      '4. 删除、覆盖、杀进程、改系统配置等有破坏性的命令（rm -rf、mv 覆盖、kill、chmod -R 等）要尽量缩小范围，并且在那条命令上一行用 # 注释写明「⚠️ 警告：…」说清楚会删除/覆盖什么。',
      '5. 不要编造路径；不确定的路径、文件名写成开头的变量（例如 DATA_DIR=…），方便用户修改。命令要可以重复运行（已存在的目录/文件要能跳过）。',
      '6. 用户给了报错时，先用一两句话说原因，再给出修复用的完整命令。',
      hardwareRule(hardware) + '（在终端里，上面提到的 %pip 一律换成 pip；查看显卡用对应厂商的 nvidia-smi / rocm-smi。）'
    ].join('\n');
  }
  if (mode === 'chat') {
    return [
      `你是 ${platform || 'Jupyter'} Notebook 旁边的问答助手，用中文回答用户的问题（编程、Python、深度学习、训练调参、平台使用、报错原因等）。`,
      '规则：',
      '1. 直接回答问题，条理清楚，用简短的段落或列表；不需要每次都写完整代码。',
      '2. 需要示例代码或命令时，放在 ``` 代码块里并标明语言（```python / ```bash）。',
      china
        ? '3. 这是国内平台，涉及安装依赖或下载模型时，提醒用清华 PyPI 镜像（https://pypi.tuna.tsinghua.edu.cn/simple）和 hf-mirror.com。'
        : '3. 这是海外平台，正常使用 PyPI 和 Hugging Face 即可。',
      '4. 不确定的事情直接说不确定，不要编造 API、参数或路径。',
      '5. 回答和硬件有关的问题（能不能跑、batch size、显存够不够等）时，按下面这份配置来回答。',
      hardwareRule(hardware)
    ].join('\n');
  }
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
    '6. 不要编造路径；不确定的路径用变量写在开头，方便用户修改。',
    hardwareRule(hardware)
  ].join('\n');
}

// fix：读取运行结果后让模型给下一步。isError === false 表示运行没报错（给“下一步”），否则按报错修复
const FIX_LINES = {
  notebook: '请修复下面这个单元格的报错，输出修好后的完整单元格。',
  terminal: '请修复下面这个单元格的报错：先用一两句话说原因，再用一个 ```bash 代码块给出修复用的完整命令。',
  chat: '请解释下面这个单元格为什么报错，并说明怎么修。'
};
const NEXT_LINES = {
  notebook: '下面是刚运行完的单元格和它的运行输出。请根据输出判断这一步有没有成功，然后输出下一步需要运行的完整单元格（如果输出里有问题，就输出修好后的完整单元格）。',
  terminal: '下面是刚运行完的单元格和它的运行输出。请根据输出判断这一步有没有成功，然后用一个 ```bash 代码块给出下一步需要运行的命令。',
  chat: '请解读下面这个单元格的运行输出，判断有没有成功，并说明下一步该做什么。'
};
export function buildUserMessage({ request, cellCode, errorOutput, fix, isError, mode = 'notebook', attachments = [] }) {
  mode = normalizeMode(mode);
  const parts = [];
  if (fix) parts.push(isError === false ? NEXT_LINES[mode] : FIX_LINES[mode]);
  if (request) parts.push('需求：' + request);
  if (cellCode) parts.push('当前单元格代码：\n```' + (/^%%(bash|sh)\b/.test(cellCode) ? 'bash' : 'python') + '\n' + cellCode.slice(0, 8000) + '\n```');
  if (errorOutput) parts.push((fix && isError === false ? '运行输出' : '最近的报错输出') + '：\n```\n' + errorOutput.slice(-4000) + '\n```');
  for (const a of attachments) {
    if (a.kind !== 'file' || !a.text) continue;
    parts.push(`附件「${a.name}」${a.truncated ? '（太长，只附上了前 ' + Math.round(a.text.length / 1024) + ' KB）' : ''}：\n\`\`\`${a.lang || ''}\n${a.text}\n\`\`\``);
  }
  return parts.join('\n\n');
}

// ---------- 聊天模式的附件：文本类文件内联进消息，图片按各家的多模态格式发送 ----------
export const MAX_FILE_CHARS = 100 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|py|ipynb|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|sh|bash|zsh|js|mjs|ts|tsx|jsx|html?|css|xml|sql|r|java|c|cc|cpp|h|hpp|go|rs|rb|php|tex|rst|env\.example|gitignore|dockerfile|properties)$/i;
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;
export function attachmentKind(name, mime) {
  if (IMAGE_MIME.test(mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(name || '')) return 'image';
  if (/^text\//.test(mime || '') || /json|xml|yaml|x-sh|x-python|javascript/.test(mime || '') || TEXT_EXT.test(name || '') || /^(Dockerfile|Makefile|requirements\.txt|README)$/i.test(name || '')) return 'file';
  return null;
}
export function langOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  return { py: 'python', ipynb: 'python', sh: 'bash', bash: 'bash', yml: 'yaml', md: 'markdown', js: 'javascript', ts: 'typescript' }[ext] || ext;
}
// .ipynb：只取各单元格的源码（不带输出），用标记分开
export function ipynbToText(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch { return raw; }
  const cells = Array.isArray(nb && nb.cells) ? nb.cells : [];
  if (!cells.length) return raw;
  return cells.map((c, i) => `# ---- 单元格 ${i + 1}（${c.cell_type || 'code'}） ----\n` + (Array.isArray(c.source) ? c.source.join('') : String(c.source || ''))).join('\n\n');
}
export function prepareTextAttachment(name, raw) {
  let text = /\.ipynb$/i.test(name) ? ipynbToText(raw) : String(raw || '');
  let truncated = false;
  if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS) + '\n…（后面还有内容，文件太长已截断）'; truncated = true; }
  return { kind: 'file', name, text, truncated, size: raw.length, lang: langOf(name) };
}
// 发给模型的用户消息内容：有图片时用多模态格式
export function openaiUserContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }))];
}
export function geminiUserParts(text, images = []) {
  const parts = [{ text }];
  for (const im of images) {
    const m = String(im.dataUrl || '').match(/^data:([^;]+);base64,(.*)$/);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  return parts;
}
// 模型不接受图片时的报错 → 中文提示（不猜哪个模型支持看图，只提示换支持图片的多模态模型）
export function visionHint(status, raw, model) {
  if (![400, 404, 415, 422].includes(status)) return ''; // 401 Key 错、403 没权限、429 额度：不是图片的问题
  if (!/image|vision|multimodal|multi-modal|modal|image_url|inline_?data|content.?type|unsupported.*content|不支持.*(图|多模态)|图片|视觉/i.test(raw || '')) return '';
  return `当前模型「${model}」好像不支持图片输入（接口返回 ${status}：${raw}）。请点右下角的模型名，换一个支持图片的多模态（视觉）模型再发；或者去掉图片只发文字。`;
}

export function extractCode(text) {
  if (!text) return '';
  const m = text.match(/```(?:python|py|ipython)?[^\n]*\n([\s\S]*?)```/i);
  if (m) return m[1].replace(/\s+$/, '') + '\n';
  return text.trim() + '\n';
}

// 终端模式：取第一个 bash/sh 代码块（没有就取第一个不标语言的代码块），去掉行首的 “$ ” 提示符
export function extractShell(text) {
  if (!text) return '';
  const blocks = [...text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const pick = blocks.find((b) => /^(bash|sh|shell|zsh|console|shellsession)$/.test(b.lang)) || blocks.find((b) => !b.lang) || blocks[0];
  const body = pick ? pick.body : text;
  return body.split('\n').map((l) => l.replace(/^\$ /, '')).join('\n').replace(/\s+$/, '').replace(/^\s*\n/, '') + '\n';
}

// 终端命令放进 Notebook 运行：%%bash 单元格（已经是 %%bash / %%sh 开头的不重复加）
export function bashCell(cmds) {
  const c = String(cmds || '').replace(/^\s*\n/, '');
  return /^%%(bash|sh)\b/.test(c) ? c : '%%bash\n' + c;
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
export async function generate(settings, { platform, hardware, userMessage, history = [], signal, mode = 'notebook', images = [] }) {
  const id = settings.active;
  const p = PRESETS[id];
  const cfg = settings.providers[id];
  const model = cfg.model;
  if (!cfg.apiKey) throw new Error(`请先在设置里填写「${p.label}」的 API Key`);
  if (!model) throw new Error('请先选择或输入模型 ID');
  const sys = systemPrompt(platform, hardware, mode);
  const think = thinkingParams(id, model, settings.thinking);
  const temperature = Number(settings.temperature) || 0.2;

  async function once(withThinking) {
    if (p.kind === 'gemini') {
      const genCfg = { temperature };
      if (withThinking && think.thinkingConfig) genCfg.thinkingConfig = think.thinkingConfig;
      const contents = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
      contents.push({ role: 'user', parts: geminiUserParts(userMessage, images) });
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
      messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: openaiUserContent(userMessage, images) }],
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
    } else {
      const hint = images.length && e.status ? visionHint(e.status, e.raw, model) : '';
      if (hint) { const e2 = new Error(hint); e2.status = e.status; e2.vision = true; throw e2; }
      throw e;
    }
  }
  if (!text) throw new Error('模型没有返回内容');
  return { text, notice, model, providerLabel: p.label };
}
