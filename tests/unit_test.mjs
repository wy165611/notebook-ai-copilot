// node tests/unit_test.mjs —— 纯函数单元测试（不需要浏览器）
import assert from 'node:assert/strict';
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
console.log('unit tests passed');
