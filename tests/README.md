# 测试

`e2e_test.py` 在本机启动**真实的 JupyterLab**、一个**本地模拟模型服务**（`mock_server.py`，同时模拟百炼/DeepSeek 的 OpenAI 兼容接口和 Gemini 接口，包括模型列表，不需要真实 Key），再用 Playwright 启动 Chromium 加载扩展，端到端验证：

1. 设置页：默认服务商（百炼）和各服务商的默认地址/模型、多个 Key 分别存在 `storage.local`、`storage.sync` 为空、清除 Key；
1. 服务商/模型/思考强度：侧边栏拉取 `/models`（过滤掉语音/向量/图像模型）并缓存、切换模型、各档位发出去的真实参数（百炼 qwen 的 `thinking_budget`、百炼 deepseek 的 `reasoning_effort`、DeepSeek 官方的 `thinking.type`、Gemini 的 `thinkingConfig.thinkingLevel`）、不支持的档位变灰、服务商拒绝参数时去参重试并提示、400 未开通/403 的错误提示、重新打开面板后记住选择；
2. JupyterLab（两种模式：普通 DOM 方式；`--LabApp.expose_app_in_browser=True` 时走 JupyterLab 命令 API）：
   检测 Notebook → 读取当前单元格和报错 → 生成代码预览 → 只插入不运行 → “插入并运行”必须先确认 → 运行并看到输出 → “修复报错” → 去掉工具栏后用快捷键兜底 → OpenAI 兼容接口；
3. Kaggle：`kaggle_top.html` 仿 www.kaggle.com 的顶层页面（结构来自真实已登录 Kaggle 的 DOM 抓取），里面的 `iframe name="notebook-editor-cells"` 来自**另一个站点**，嵌的是本机真实 JupyterLab 4（不暴露 `window.jupyterapp`）。用 Chromium 的 `--host-resolver-rules` 把 `www.kaggle.test`、`kkb-production.jupyter-proxy.kagglenet.test` 指向本机。验证：顶层回报“不是 Notebook”、侧边栏连到 iframe、读代码和报错、插入、确认后运行、修复报错、工具栏隐藏/按钮缺失时的兜底。

测试用的扩展副本由 `build_test_ext.py` 生成到 `/tmp/nbac-test-ext`，只在副本里额外允许 `127.0.0.1/localhost`、`*.kaggle.test`/`*.kagglenet.test` 和 `tabs` 权限，**发布用的 manifest.json 不变**。
侧边栏在测试里以独立弹窗（`index.html?tabId=…`）打开，界面和真正的侧边栏是同一个页面。

```bash
python3 -m venv .venv && .venv/bin/pip install jupyterlab ipykernel playwright
.venv/bin/python -m playwright install chromium
export PATH=$PWD/.venv/bin:$PATH
xvfb-run -a -s "-screen 0 1920x1200x24" python tests/e2e_test.py   # 默认 xvfb 屏幕太小；有桌面可直接运行
node tests/unit_test.mjs                           # 纯函数单元测试
```

截图保存在 `/tmp/nbac-shots/`（可用 `NBAC_SHOT_DIR` 修改）。
