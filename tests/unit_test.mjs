// node tests/unit_test.mjs —— 纯函数单元测试（不需要浏览器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PROBE_CODE, AUTO_PROBE_CODE, parseProbeOutput, mergeHardware, hardwareLabel, hardwareRule } from '../src/lib/hardware.js';
import { MAIN_SCRIPTS, ISOLATED_SCRIPTS, classifyInjectError, originPattern, isInternalUrl } from '../src/lib/inject.js';
import { extractCode, extractShell, bashCell, systemPrompt, buildUserMessage, thinkingParams, supportedThinking, filterChatModels, PRESETS, DEFAULTS, MODES, MODE_LABELS, normalizeMode,
  attachmentKind, ipynbToText, prepareTextAttachment, MAX_FILE_CHARS, openaiUserContent, geminiUserParts, visionHint } from '../src/lib/llm.js';
import { ERR_READ_CODE, parseErrLine } from '../src/lib/errread.js';

assert.equal(extractCode('说明\n```python\nprint(1)\n```\n其他'), 'print(1)\n');
assert.equal(extractCode('```\n%pip install x\n```'), '%pip install x\n');
assert.equal(extractCode('print(2)'), 'print(2)\n');
assert.match(systemPrompt('飞桨 AI Studio'), /pypi\.tuna\.tsinghua\.edu\.cn/);
assert.match(systemPrompt('ModelScope'), /pypi\.tuna\.tsinghua\.edu\.cn/);
assert.match(systemPrompt('安睿云 JupyterLab'), /pypi\.tuna\.tsinghua\.edu\.cn/);
assert.doesNotMatch(systemPrompt('Kaggle'), /tsinghua/);
const m = buildUserMessage({ request: 'r', cellCode: 'a=1', errorOutput: 'Err', fix: true });
assert.match(m, /请修复/); assert.match(m, /a=1/); assert.match(m, /Err/);

assert.equal(DEFAULTS.active, 'bailian');
assert.equal(PRESETS.bailian.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
assert.equal(PRESETS.bailian.model, 'deepseek-v4.1-flash');
assert.equal(PRESETS.deepseek.baseUrl, 'https://api.deepseek.com');
assert.equal(PRESETS.deepseek.model, 'deepseek-flash');
assert.deepEqual(thinkingParams('deepseek', 'deepseek-flash', 'off'), { thinking: { type: 'disabled' } });
assert.deepEqual(thinkingParams('deepseek', 'deepseek-flash', 'max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
assert.deepEqual(thinkingParams('deepseek', 'deepseek-flash', 'medium'), {});
assert.deepEqual(thinkingParams('bailian', 'deepseek-v4.1-flash', 'low'), { enable_thinking: true, reasoning_effort: 'low' });
assert.deepEqual(thinkingParams('bailian', 'qwen3.8-max', 'medium'), { enable_thinking: true, thinking_budget: 4096 });
assert.deepEqual(thinkingParams('bailian', 'qwen3.8-max', 'max'), { enable_thinking: true });
assert.deepEqual(thinkingParams('bailian', 'kimi-k3', 'high'), { enable_thinking: true });
assert.deepEqual(thinkingParams('bailian', 'glm-5.3', 'off'), { enable_thinking: false });
assert.deepEqual(thinkingParams('gemini', 'gemini-3.5-flash', 'off'), { thinkingConfig: { thinkingLevel: 'minimal' } });
assert.ok(!supportedThinking('gemini', 'gemini-3.8-flash').includes('off'));
assert.deepEqual(thinkingParams('gemini', 'gemini-2.5-flash', 'off'), { thinkingConfig: { thinkingBudget: 0 } });
assert.deepEqual(thinkingParams('custom', 'gpt-x', 'high'), { reasoning_effort: 'high' });
assert.deepEqual(thinkingParams('bailian', 'qwen3.8-max', 'default'), {});
assert.deepEqual(filterChatModels(['qwen3.8-max', 'paraformer-v2', 'qwen-tts', 'text-embedding-v4', 'qwen3-vl-plus', 'wanx2.1-t2i']), ['qwen3.8-max', 'qwen3-vl-plus']);
// ---------- 内容脚本的纯函数（src/content/nb-helpers.js） ----------
{
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(new URL('../src/content/nb-helpers.js', import.meta.url), 'utf8'), sandbox);
  const H = sandbox.__nbacHelpers;
  const code = 'import numpy as np\nif True:\n    print((1, [2]))\n# done\n';
  assert.ok(H.codeMatches(code, code));
  { const long = Array.from({ length: 40 }, (_, i) => 'x' + i).join('\n');
    assert.ok(H.codeMatches('x37\nx38\nx39', long), '只渲染了末尾几行也算写对');
    assert.ok(!H.codeMatches('x36\nx37\nx38', long), '没有最后一行不算');
    assert.ok(!H.codeMatches('x38\nx39', long), '少于 3 行不算'); }
  assert.ok(H.codeMatches('import numpy as np  \r\nif True:\n    print((1, [2]))\n# done', code), '行尾空白和 \\r 不算差异');
  assert.ok(!H.codeMatches(code.replace('# done', '    # done'), code), '缩进不同必须算不一致（自动缩进）');
  assert.ok(!H.codeMatches(code.replace('[2])', '[2]))'), code), '多出括号必须算不一致（自动补括号）');
  assert.ok(!H.codeMatches('', code));
  const long = Array.from({ length: 60 }, (_, i) => 'x' + i + ' = ' + i).join('\n');
  assert.ok(H.codeMatches(long.split('\n').slice(0, 25).join('\n'), long), '超长单元格只渲染了前 25 行也算');
  assert.ok(!H.codeMatches(long.split('\n').slice(0, 5).join('\n'), long), '只渲染 5 行不够判断');
  assert.equal(H.joinViewLines([{ top: '19px', text: 'b\u00a0=\u00a02' }, { top: '0px', text: 'a = 1' }]), 'a = 1\nb = 2');
  assert.equal(H.joinViewLines([{ text: 'a' }, { text: 'b' }]), 'a\nb');
  // 平台识别
  assert.equal(H.platformFromHost('jupyter.anruicloud.com'), '安睿云 JupyterLab');
  assert.equal(H.platformFromHost('JUPYTER.AnruiCloud.com'), '安睿云 JupyterLab');
  assert.equal(H.platformFromHost('anruicloud.com'), '安睿云 JupyterLab');
  assert.equal(H.platformFromHost('jupyter.anruicloud.test'), '安睿云 JupyterLab');
  assert.equal(H.platformFromHost('anruicloud.com.evil.example'), 'Jupyter', '只认真正的 anruicloud.com 域名');
  assert.equal(H.platformFromHost('notanruicloud.com'), 'Jupyter');
  assert.equal(H.platformFromHost('aistudio.baidu.com'), '飞桨 AI Studio');
  assert.equal(H.platformFromHost('modelscope.cn'), 'ModelScope');
  assert.equal(H.platformFromHost('dsw-gateway-cn-hangzhou.data.aliyun.com'), 'ModelScope DSW');
  assert.equal(H.platformFromHost('www.modelscope.cn'), 'ModelScope');
  assert.equal(H.platformFromHost('kkb-production.jupyter-proxy.kaggle.net'), 'Kaggle');
  assert.equal(H.platformFromHost('127.0.0.1'), 'Jupyter');
  const ms = (o) => H.vscodeKernelHint({ hasButton: true, label: '', pageText: '', ...o });
  assert.match(ms({ label: '/usr/bin/python3 Python 3.10.12' }), /\/usr\/local\/bin\/python/);
  assert.match(ms({ label: '/bin/python3' }), /ipykernel/);
  assert.equal(ms({ label: '/usr/local/bin/python Python 3.11.11' }), '');
  assert.match(ms({ label: 'Select Kernel' }), /还没有选内核/);
  assert.match(ms({ hasButton: false }), /还没有选内核/);
  assert.match(ms({ label: '/usr/local/bin/python', pageText: "Running cells with 'Python 3.10.12' requires the ipykernel package." }), /没有 ipykernel/);
}

// ---------- early.js：记录 Lumino widget 这种“对象监听器” ----------
{
  const calls = [];
  class FakeTarget { addEventListener(type, l) { calls.push([type, l]); } }
  const sandbox = { EventTarget: FakeTarget };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL('../src/content/early.js', import.meta.url), 'utf8'), sandbox);
  const map = sandbox.__nbacEarly.listenerObjects;
  const node = new FakeTarget();
  const other = { node, handleEvent() {} };
  const nb = { node, handleEvent() {}, get activeCell() { return null; } };
  node.addEventListener('focusin', other);
  assert.equal(map.get(node), other);
  node.addEventListener('mousedown', nb);
  assert.equal(map.get(node), nb, '有 activeCell 的 widget 优先');
  node.addEventListener('keydown', other);
  assert.equal(map.get(node), nb, '不会被后注册的普通对象覆盖');
  const n2 = new FakeTarget();
  n2.addEventListener('click', () => {});
  n2.addEventListener('click', { handleEvent() {}, node: {} });
  assert.equal(map.get(n2), undefined, '函数监听器、node 不是自己的对象都不记录');
  assert.equal(calls.length, 5, '原来的 addEventListener 照常被调用');
}

// 安睿云：页面文字里没有显卡信息，但 JupyterLab 插件里有 @amd-oneclick/* 时识别为 AMD
{
  const sb = {}; vm.runInNewContext(fs.readFileSync(new URL('../src/content/nb-helpers.js', import.meta.url), 'utf8'), sb);
  const H = sb.__nbacHelpers;
  const r = H.parseHardwareHints({ text: 'Launcher Notebook Python 3 (ipykernel)', url: 'https://jupyter.anruicloud.com/instances/x/lab', extensions: ['@jupyterlab/application', '@amd-oneclick/resource-status'] });
  assert.equal(r && r.vendor, 'amd');
  assert.equal(r.source, 'jupyterlab');
  const n = H.parseHardwareHints({ text: 'GPU: Tesla T4', url: 'https://www.kaggle.com/code/x', extensions: ['@jupyterlab/application', '@amd-oneclick/x'] });
  assert.equal(n.vendor, 'nvidia', '页面文字明确写了 NVIDIA 时以文字为准');
  assert.equal(H.parseHardwareHints({ text: '', url: 'https://x/lab', extensions: ['@jupyterlab/commands'] }), null);
}

// manifest：安睿云域名在所有内容脚本里都匹配、全部 frame 注入
{
  const man = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(man.version, '0.1.14');
  for (const f of ['src/content/page.js', 'src/content/bridge.js', 'src/content/nb-helpers.js']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const m = src.match(/const BUILD = '([^']+)'/);
    assert.ok(m && m[1] === man.version, f + ' 的 BUILD 必须等于 manifest version（否则网页里残留的旧脚本会挡住新版）');
  }
  for (const perm of ['sidePanel', 'storage', 'scripting', 'activeTab']) assert.ok(man.permissions.includes(perm), perm);
  assert.ok(!man.permissions.includes('tabs'), '发布版不要 tabs 权限');
  assert.ok(man.host_permissions.includes('https://*.anruicloud.com/*'));
  for (const h of man.content_scripts[0].matches) assert.ok(man.host_permissions.includes(h), '平台域名也要在 host_permissions 里：' + h);
  assert.deepEqual(man.optional_host_permissions, ['https://*/*', 'http://*/*']);
  // 侧边栏注入的脚本和 manifest 里的一致
  const files = man.content_scripts.flatMap((c) => c.js);
  // 侧边栏注入的脚本和 manifest 里的一致
  assert.deepEqual([...MAIN_SCRIPTS, ...ISOLATED_SCRIPTS].sort(), [...new Set(files)].sort());
  for (const f of ['src/content/early.js', 'src/content/nb-helpers.js', 'src/content/page.js', 'src/content/bridge.js']) assert.ok(files.includes(f), f);
  for (const cs of man.content_scripts) {
    assert.ok(cs.matches.includes('https://*.anruicloud.com/*'), cs.js.join(','));
    assert.equal(cs.all_frames, true);
  }
  // Chrome 的匹配规则 https://*.anruicloud.com/* 覆盖 jupyter.anruicloud.com 的任意路径
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('://\\*\\.', '://([^/]+\\.)?').replace(/\*/g, '.*') + '$');
  const re = toRe('https://*.anruicloud.com/*');
  assert.ok(re.test('https://jupyter.anruicloud.com/instances/rgapi-one-click-31516-7e36ddc9/lab'));
  assert.ok(re.test('https://jupyter.anruicloud.com/instances/x/lab/tree/a/b.ipynb'));
  assert.ok(!re.test('https://jupyter.anruicloud.com.evil.example/lab'));
}

// ---------- 硬件：页面提示解析（nb-helpers.parseHardwareHints） ----------
{
  const sandbox = { URL };
  vm.runInNewContext(fs.readFileSync(new URL('../src/content/nb-helpers.js', import.meta.url), 'utf8'), sandbox);
  const P = (text, url = 'https://x.example/') => JSON.parse(JSON.stringify(sandbox.__nbacHelpers.parseHardwareHints({ text, url })));
  let h = P('AMD Radeon Cloud   GPU 0%  VRAM 0.2/48 GB  RAM 3/64 GB  CPU 1%');
  assert.equal(h.vendor, 'amd'); assert.equal(h.vramGB, 48); assert.equal(h.source, 'page');
  assert.equal(P('AMD Radeon Cloud').vendor, 'amd', '安睿云顶栏的 “AMD Radeon Cloud” 就足够判断是 AMD');
  assert.equal(P('Radeon PRO W7900 48GB VRAM').model, 'Radeon PRO W7900');
  assert.equal(P('Instinct MI300X').model, 'Instinct MI300X');
  h = P('Accelerator GPU T4 x2'); assert.equal(h.vendor, 'nvidia'); assert.equal(h.model, 'T4 ×2');
  assert.equal(P('GPU P100').model, 'P100');
  h = P('Tesla V100 32GB 显存 32GB'); assert.equal(h.vendor, 'nvidia'); assert.equal(h.vramGB, 32);
  assert.equal(P('至尊版 GPU A100 40GB').vendor, 'nvidia');
  assert.equal(P('基础版 CPU 2 核 8GB'), null, '只有 CPU 字样不下结论');
  assert.equal(P('T4 is a word in text'), null, '没有 GPU 上下文的 T4 不算');
  assert.equal(P('', 'https://modelscope.cn/my/mynotebook?acceleratorType=CPU').vendor, 'cpu');
  assert.equal(P('', 'https://modelscope.cn/my/mynotebook?acceleratorType=GPU').vendor, 'nvidia');
  assert.equal(P('GPU 0% VRAM 0/24 GB').vendor, 'gpu');
}

// ---------- 硬件：检测结果、合并、显示、提示词 ----------
{
  const amd = parseProbeOutput('blah\nNBAC_HW {"vendor":"amd","devices":[{"name":"AMD Radeon PRO W7900","vram_gb":48.0}],"torch":"2.5.1+rocm6.2","hip_build":"6.2.41133","cuda_build":null}\n');
  assert.equal(amd.vendor, 'amd'); assert.equal(amd.model, 'AMD Radeon PRO W7900'); assert.equal(amd.vramGB, 48); assert.equal(amd.source, 'probe');
  const cpu = parseProbeOutput('NBAC_HW {"python":"3.12.0","cpu_count":8,"vendor":"cpu","devices":[],"torch_error":"ModuleNotFoundError: x"}');
  assert.equal(cpu.vendor, 'cpu'); assert.ok(cpu.torchMissing);
  assert.equal(parseProbeOutput('NBAC_HW {"vendor":"amd","devices":[],"smi":"GPU[0] : Card series: AMD Instinct MI210"}').model, 'AMD Instinct MI210');
  const full = parseProbeOutput('NBAC_HW {"vendor":"nvidia","devices":[{"name":"Tesla T4","vram_gb":15.0},{"name":"Tesla T4","vram_gb":15.0}],"cpu_count":4,"ram_gb":31.4,"torch":"2.4"}');
  assert.equal(full.cpuCores, 4); assert.equal(full.ramGB, 31.4);
  assert.equal(hardwareLabel(full), 'NVIDIA GPU（CUDA） Tesla T4 ×2，15 GB 显存 · 4 核 CPU，31.4 GB 内存 · 已检测');
  assert.match(hardwareRule(full), /num_workers 不超过 CPU 核数/);
  assert.equal(parseProbeOutput('no line'), null);
  assert.equal(parseProbeOutput('NBAC_HW {broken'), null);
  const nv = parseProbeOutput('NBAC_HW {"vendor":"nvidia","devices":[{"name":"Tesla T4","vram_gb":14.7},{"name":"Tesla T4","vram_gb":14.7}],"torch":"2.4","cuda_build":"12.1"}');
  assert.equal(nv.model, 'Tesla T4 ×2');
  // 合并：检测结果 > 页面文字 > 网址
  const pageAmd = { vendor: 'amd', model: '', vramGB: 48, source: 'page' };
  const urlCpu = { vendor: 'cpu', source: 'url' };
  assert.equal(mergeHardware(null, [null, urlCpu, pageAmd]), pageAmd);
  const merged = mergeHardware(cpu, [pageAmd]);
  assert.equal(merged.vendor, 'amd', '检测没找到 GPU 但页面写了 AMD：显卡按页面');
  assert.equal(merged.cpuCores, 8, 'CPU 核数按检测结果');
  assert.equal(mergeHardware(amd, [urlCpu]), amd);
  const cpuWithTorch = { ...cpu, torchMissing: false };
  assert.equal(mergeHardware(cpuWithTorch, [pageAmd]), cpuWithTorch, '有 torch 且确认没有 GPU 时以检测结果为准');
  assert.equal(mergeHardware(null, [null]), null);
  assert.equal(hardwareLabel(pageAmd), 'AMD GPU（ROCm） 48 GB 显存 · 页面提示');
  assert.match(hardwareLabel(amd), /^AMD GPU（ROCm） AMD Radeon PRO W7900，48 GB 显存 · 已检测$/);
  assert.match(hardwareLabel(null), /未知/);
  // 提示词：AMD → ROCm 规则
  const sp = systemPrompt('安睿云 JupyterLab', pageAmd);
  assert.match(sp, /AMD GPU/); assert.match(sp, /ROCm/); assert.match(sp, /"cuda"/); assert.match(sp, /rocm-smi/);
  assert.match(sp, /不要用 nvidia-smi/); assert.match(sp, /bitsandbytes/); assert.match(sp, /flash-attn/);
  assert.match(sp, /https:\/\/download\.pytorch\.org\/whl\/rocm6\.x/); assert.match(sp, /不要重装/);
  assert.match(sp, /pypi\.tuna/);
  // 硬件未知：要求先做设备检测（含 ROCm 判断和 CPU 兜底）
  const su = systemPrompt('Kaggle');
  assert.match(su, /硬件未知/); assert.match(su, /torch\.cuda\.is_available\(\)/); assert.match(su, /torch\.version\.hip/);
  assert.match(su, /torch\.version\.cuda/); assert.match(su, /get_device_name/); assert.match(su, /device="cpu"/); assert.match(su, /rocm-smi/);
  const sn = systemPrompt('Kaggle', nv);
  assert.match(sn, /NVIDIA GPU（Tesla T4 ×2/); assert.doesNotMatch(sn, /ROCm/);
  const sc = systemPrompt('ModelScope', cpu);
  assert.match(sc, /只有 CPU/); assert.match(sc, /device="cpu"/);
  // 检测代码：只读、打印 NBAC_HW，不安装任何东西
  assert.match(PROBE_CODE, /line = "NBAC_HW " \+ json\.dumps/); assert.match(PROBE_CODE, /print\(line\)/);
  assert.match(PROBE_CODE, /_nbac_probe\(\)\ndel _nbac_probe/);
  assert.match(AUTO_PROBE_CODE, /_nbac_probe\(replace=True\)\ndel _nbac_probe/); assert.notEqual(AUTO_PROBE_CODE, PROBE_CODE);
  assert.match(AUTO_PROBE_CODE, /set_next_input\("# 硬件检测结果[^"]*\\n# " \+ line, replace=True\)/);
  assert.equal(parseProbeOutput('# NBAC_HW {"vendor":"nvidia","devices":[{"name":"A10","vram_gb":22}],"cpu_count":8,"ram_gb":30,"torch":"2.3"}').cpuCores, 8);
  assert.match(hardwareRule({ vendor: 'nvidia', model: 'A10', vramGB: 22, cpuCores: 8, ramGB: 30 }), /所有代码都要按上面这份实际配置来写/);
  assert.doesNotMatch(hardwareRule(null), /实际配置/); assert.doesNotMatch(PROBE_CODE, /pip install|%pip/);
  assert.match(PROBE_CODE, /torch\.version, "hip"/); assert.match(PROBE_CODE, /rocm-smi/); assert.match(PROBE_CODE, /timeout=20/);
}

// ---------- 注入失败分类 / 权限匹配模式 ----------
{
  assert.equal(classifyInjectError('Cannot access contents of url "https://a.example/lab". Extension manifest must request permission to access this host.', 'https://a.example/lab'), 'permission');
  assert.equal(classifyInjectError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.', ''), 'permission');
  assert.equal(classifyInjectError('This page cannot be scripted due to an ExtensionsSettings policy.', ''), 'policy');
  assert.equal(classifyInjectError('Cannot access a chrome:// URL', ''), 'restricted');
  assert.equal(classifyInjectError('The extensions gallery cannot be scripted.', ''), 'restricted');
  assert.equal(classifyInjectError('whatever', 'chrome://settings/'), 'restricted');
  assert.equal(classifyInjectError('No tab with id: 5.', ''), 'gone');
  assert.equal(originPattern('https://jupyter.anruicloud.com/instances/x/lab?y=1'), 'https://jupyter.anruicloud.com/*');
  assert.equal(originPattern('http://10.0.0.5:8888/lab'), 'http://10.0.0.5/*');
  assert.equal(originPattern('chrome://settings'), null);
  assert.equal(originPattern(''), null);
  assert.ok(isInternalUrl('chrome://extensions')); assert.ok(!isInternalUrl('')); assert.ok(!isInternalUrl('https://a/'));
}
// ---------- 三种模式：Notebook / 终端 / 聊天 ----------
{
  assert.deepEqual(MODES, ['notebook', 'terminal', 'chat']);
  assert.deepEqual(MODE_LABELS, { notebook: 'Notebook', terminal: '终端', chat: '聊天' });
  assert.equal(DEFAULTS.mode, 'notebook'); assert.equal(DEFAULTS.autoFix, false);
  assert.equal(normalizeMode('chat'), 'chat'); assert.equal(normalizeMode('x'), 'notebook'); assert.equal(normalizeMode(undefined), 'notebook');
  // Notebook 模式和以前完全一样（默认参数）
  assert.equal(systemPrompt('Kaggle', null, 'notebook'), systemPrompt('Kaggle'));
  assert.match(systemPrompt('Kaggle'), /```python/);
  // 终端模式：bash 代码块、非交互、破坏性命令要警告、国内镜像、按硬件写
  const nvHw = { vendor: 'nvidia', model: 'A10', vramGB: 22, cpuCores: 8, ramGB: 30, source: 'probe' };
  const t = systemPrompt('ModelScope', nvHw, 'terminal');
  assert.match(t, /终端（bash）助手/); assert.match(t, /```bash/); assert.doesNotMatch(t, /```python 代码块里/);
  assert.match(t, /-y/); assert.match(t, /非交互/); assert.match(t, /警告/); assert.match(t, /rm -rf/);
  assert.match(t, /pypi\.tuna\.tsinghua\.edu\.cn/); assert.match(t, /hf-mirror\.com/);
  assert.match(t, /NVIDIA GPU（A10/); assert.match(t, /所有代码都要按上面这份实际配置来写/); assert.match(t, /%pip 一律换成 pip/);
  assert.doesNotMatch(systemPrompt('Kaggle', null, 'terminal'), /tsinghua|hf-mirror/);
  assert.match(systemPrompt('安睿云 JupyterLab', { vendor: 'amd', vramGB: 48, source: 'page' }, 'terminal'), /rocm-smi/);
  // 聊天模式：问答、不要求只输出单元格、带硬件配置
  const c = systemPrompt('飞桨 AI Studio', nvHw, 'chat');
  assert.match(c, /问答助手/); assert.doesNotMatch(c, /只输出一个/); assert.match(c, /pypi\.tuna/); assert.match(c, /NVIDIA GPU（A10/);
  assert.doesNotMatch(systemPrompt('Kaggle', null, 'chat'), /tsinghua/);
  // 提取 bash 命令
  assert.equal(extractShell('说明\n```bash\n$ pip install x -i https://pypi.tuna.tsinghua.edu.cn/simple\nnvidia-smi\n```\n完'), 'pip install x -i https://pypi.tuna.tsinghua.edu.cn/simple\nnvidia-smi\n');
  assert.equal(extractShell('```python\nprint(1)\n```\n```sh\nls -la\n```'), 'ls -la\n', '有 python 和 sh 两个代码块时取 sh');
  assert.equal(extractShell('```\ndf -h\n```'), 'df -h\n');
  assert.equal(extractShell('```console\n$ free -g\n```'), 'free -g\n');
  assert.equal(extractShell('echo hi'), 'echo hi\n');
  assert.equal(extractShell(''), '');
  assert.equal(bashCell('echo 1\n'), '%%bash\necho 1\n');
  assert.equal(bashCell('%%bash\necho 1\n'), '%%bash\necho 1\n', '已经是 %%bash 的不重复加');
  assert.equal(bashCell('%%sh\nls\n'), '%%sh\nls\n');
}
// 侧边栏：三个模式按钮、清空记录入口、聊天记录存储键
{
  const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
  for (const [m, l] of [['notebook', 'Notebook'], ['terminal', '终端'], ['chat', '聊天']]) assert.match(html, new RegExp(`data-mode="${m}" role="tab"[^>]*>${l}</button>`));
  // 0.1.14：对话记录抽屉（多个对话）、新对话、删除全部；不再有逐条删除
  for (const id of ['historyBtn', 'newChat', 'convDrawer', 'convList', 'convNew', 'convDeleteAll', 'convAllConfirm', 'attachFile', 'fileInput', 'attachChips', 'autoFix']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /删除全部对话？/); assert.doesNotMatch(html, /clearHistory|清空全部聊天记录/);
  assert.match(html, /class="menu-item chat-only[^"]*" id="attachFile"/, '聊天模式的 + 是添加图片或文件');
  assert.match(html, /class="menu-item nb-only" id="fixError"/);
  const js = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
  assert.match(js, /const CONV_INDEX = 'nbacConvIndex'/); assert.match(js, /const OLD_CHAT_KEY = 'nbacChatHistory'/);
  assert.match(js, /const CONV_MAX = 100/); assert.match(js, /const MSG_MAX = 200/);
  assert.doesNotMatch(js, /msg-del/, '不再有逐条删除按钮');
  assert.doesNotMatch(js.slice(js.indexOf('function record('), js.indexOf('function updateRecord(')), /apiKey|dataUrl/, '聊天记录里不存 Key 和图片数据');
  assert.match(js, /attMeta = atts\.map\(\(a\) => \(\{ kind: a\.kind, name: a\.name, size: a\.size, truncated: !!a\.truncated \}\)\)/, '附件只存名字等信息');
}
// ---------- 0.1.14：读取运行结果给下一步、附件、多模态、读取报错单元格、AMD CPU 不算 AMD 显卡 ----------
{
  // 修复 / 下一步
  const fixNb = buildUserMessage({ cellCode: 'raise X', errorOutput: 'ValueError: boom', fix: true, isError: true, mode: 'notebook' });
  assert.match(fixNb, /请修复下面这个单元格的报错，输出修好后的完整单元格/); assert.match(fixNb, /最近的报错输出/);
  const nextNb = buildUserMessage({ cellCode: 'print(1)', errorOutput: '1', fix: true, isError: false, mode: 'notebook' });
  assert.match(nextNb, /请根据输出判断这一步有没有成功/); assert.match(nextNb, /下一步需要运行的完整单元格/); assert.match(nextNb, /运行输出：/); assert.doesNotMatch(nextNb, /请修复/);
  const fixT = buildUserMessage({ cellCode: '%%bash\nexit 3', errorOutput: 'CalledProcessError', fix: true, isError: true, mode: 'terminal' });
  assert.match(fixT, /```bash 代码块/); assert.match(fixT, /```bash\n%%bash/, '%%bash 单元格按 bash 标注');
  assert.match(buildUserMessage({ errorOutput: 'x', fix: true, isError: false, mode: 'terminal' }), /下一步需要运行的命令/);
  assert.match(buildUserMessage({ errorOutput: 'x', fix: true, mode: 'chat' }), /请解释下面这个单元格为什么报错/);
  // 附件
  assert.equal(attachmentKind('a.png', 'image/png'), 'image'); assert.equal(attachmentKind('a.JPG', ''), 'image'); assert.equal(attachmentKind('x.webp', 'image/webp'), 'image');
  for (const n of ['a.txt', 'b.md', 'c.py', 'd.ipynb', 'e.csv', 'f.json', 'g.yaml', 'h.yml', 'i.log', 'requirements.txt', 'Dockerfile']) assert.equal(attachmentKind(n, ''), 'file', n);
  assert.equal(attachmentKind('x.pdf', 'application/pdf'), null); assert.equal(attachmentKind('x.zip', 'application/zip'), null);
  const nb = JSON.stringify({ cells: [{ cell_type: 'code', source: ['import os\n', 'print(1)'], outputs: [{ text: 'SECRET_OUTPUT' }] }, { cell_type: 'markdown', source: '# 标题' }] });
  const t = ipynbToText(nb);
  assert.match(t, /单元格 1（code）/); assert.match(t, /import os\nprint\(1\)/); assert.match(t, /# 标题/); assert.doesNotMatch(t, /SECRET_OUTPUT/, '.ipynb 只取源码不取输出');
  const big = prepareTextAttachment('big.log', 'x'.repeat(MAX_FILE_CHARS + 500));
  assert.ok(big.truncated); assert.match(big.text, /文件太长已截断/); assert.ok(big.text.length < MAX_FILE_CHARS + 100);
  const small = prepareTextAttachment('a.py', 'print(1)'); assert.ok(!small.truncated); assert.equal(small.lang, 'python');
  const um = buildUserMessage({ request: '看看', attachments: [small, big, { kind: 'image', name: 'p.png', dataUrl: 'data:image/png;base64,AAAA' }] });
  assert.match(um, /附件「a\.py」：\n```python\nprint\(1\)/); assert.match(um, /附件「big\.log」（太长/); assert.doesNotMatch(um, /base64/, '图片不进文字消息');
  assert.equal(openaiUserContent('hi'), 'hi');
  assert.deepEqual(openaiUserContent('hi', [{ dataUrl: 'data:image/png;base64,AAAA' }]), [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  assert.deepEqual(geminiUserParts('hi', [{ dataUrl: 'data:image/jpeg;base64,BBBB' }]), [{ text: 'hi' }, { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }]);
  assert.match(visionHint(400, 'image_url is only supported by multimodal models', 'qwen-x'), /不支持图片输入.*换一个支持图片的多模态/);
  assert.equal(visionHint(401, 'image', 'm'), ''); assert.equal(visionHint(400, 'Unrecognized request argument', 'm'), '');
  // 读取报错单元格：只读、写回 NBAC_ERR、不改用户代码
  assert.match(ERR_READ_CODE, /sys, "last_value"/); assert.match(ERR_READ_CODE, /set_next_input\("# 上一次运行的报错[^"]*\\n# NBAC_ERR " \+ json\.dumps\(info, ensure_ascii=False\), replace=True\)/);
  assert.match(ERR_READ_CODE, /\n_nbac_last_error\(\)\ndel _nbac_last_error\n$/); assert.doesNotMatch(ERR_READ_CODE, /pip install|%pip/);
  assert.deepEqual(parseErrLine('{"ok": true}'), { ok: true, text: '' });
  assert.equal(parseErrLine('{"ok": false, "ename": "ValueError", "evalue": "x", "tb": "Traceback...\\nValueError: x"}').text, 'Traceback...\nValueError: x');
  assert.equal(parseErrLine('{"ok": false, "ename": "E", "evalue": "v"}').text, 'E: v');
  assert.equal(parseErrLine('garbage'), null);
  // 报错识别、AMD CPU 不算 AMD 显卡（PAI-DSW 实例规格里常写 AMD EPYC）
  const sb = { URL }; vm.runInNewContext(fs.readFileSync(new URL('../src/content/nb-helpers.js', import.meta.url), 'utf8'), sb);
  const H = sb.__nbacHelpers;
  assert.ok(H.looksLikeError('Traceback (most recent call last):\n  ...\nValueError: x'));
  assert.ok(H.looksLikeError("CalledProcessError: Command 'b'x'' returned non-zero exit status 3."));
  assert.ok(H.looksLikeError('bash: foo: command not found'));
  assert.ok(H.looksLikeError('ERROR: Could not find a version that satisfies the requirement x'));
  assert.ok(!H.looksLikeError('NBAC_OK 42 True')); assert.ok(!H.looksLikeError('')); assert.ok(!H.looksLikeError('loss=0.3 errors_total 0'));
  const P = (text) => JSON.parse(JSON.stringify(H.parseHardwareHints({ text, url: 'https://dsw-gateway-cn-hangzhou.data.aliyun.com/dsw-1/ide/' })));
  assert.equal(P('实例规格 ecs.c7a.2xlarge（CPU：AMD EPYC 7T83 64-Core Processor，8 vCPU 32 GiB）'), null, 'AMD EPYC 是 CPU，不是 AMD 显卡');
  assert.equal(P('AMD Ryzen 9 7950X'), null);
  assert.equal(P('CPU AMD EPYC 7763 · GPU NVIDIA A10 24GB').vendor, 'nvidia');
  assert.equal(P('AMD EPYC 9654 + AMD Instinct MI300X').vendor, 'amd', '同时有 AMD 显卡时仍然是 AMD');
  assert.equal(P('AMD Radeon Cloud').vendor, 'amd');
}
console.log('unit tests passed');
