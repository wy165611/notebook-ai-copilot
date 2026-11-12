// node tests/unit_test.mjs —— 纯函数单元测试（不需要浏览器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PROBE_CODE, parseProbeOutput, mergeHardware, hardwareLabel } from '../src/lib/hardware.js';
import { MAIN_SCRIPTS, ISOLATED_SCRIPTS, classifyInjectError, originPattern, isInternalUrl } from '../src/lib/inject.js';
import { extractCode, systemPrompt, buildUserMessage, thinkingParams, supportedThinking, filterChatModels, PRESETS, DEFAULTS } from '../src/lib/llm.js';

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
  assert.equal(H.platformFromHost('dsw-gateway-cn-hangzhou.data.aliyun.com'), 'ModelScope');
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
  assert.equal(man.version, '0.1.7');
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
  assert.equal(parseProbeOutput('no line'), null);
  assert.equal(parseProbeOutput('NBAC_HW {broken'), null);
  const nv = parseProbeOutput('NBAC_HW {"vendor":"nvidia","devices":[{"name":"Tesla T4","vram_gb":14.7},{"name":"Tesla T4","vram_gb":14.7}],"torch":"2.4","cuda_build":"12.1"}');
  assert.equal(nv.model, 'Tesla T4 ×2');
  // 合并：检测结果 > 页面文字 > 网址
  const pageAmd = { vendor: 'amd', model: '', vramGB: 48, source: 'page' };
  const urlCpu = { vendor: 'cpu', source: 'url' };
  assert.equal(mergeHardware(null, [null, urlCpu, pageAmd]), pageAmd);
  assert.equal(mergeHardware(cpu, [pageAmd]), cpu);
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
  assert.match(PROBE_CODE, /print\("NBAC_HW " \+ json\.dumps/); assert.doesNotMatch(PROBE_CODE, /pip install|%pip/);
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
console.log('unit tests passed');
