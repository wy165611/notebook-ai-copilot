// node tests/unit_test.mjs —— 纯函数单元测试（不需要浏览器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { extractCode, systemPrompt, buildUserMessage, thinkingParams, supportedThinking, filterChatModels, PRESETS, DEFAULTS } from '../src/lib/llm.js';

assert.equal(extractCode('说明\n```python\nprint(1)\n```\n其他'), 'print(1)\n');
assert.equal(extractCode('```\n%pip install x\n```'), '%pip install x\n');
assert.equal(extractCode('print(2)'), 'print(2)\n');
assert.match(systemPrompt('飞桨 AI Studio'), /pypi\.tuna\.tsinghua\.edu\.cn/);
assert.match(systemPrompt('ModelScope'), /pypi\.tuna\.tsinghua\.edu\.cn/);
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

console.log('unit tests passed');
