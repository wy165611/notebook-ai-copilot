# 测试

`e2e_test.py` 在本机启动**真实的 JupyterLab**、一个**本地模拟模型服务**（`mock_server.py`，同时模拟百炼/DeepSeek 的 OpenAI 兼容接口和 Gemini 接口，包括模型列表，不需要真实 Key），再用 Playwright 启动 Chromium 加载扩展，端到端验证：

1. 设置页：默认服务商（百炼）和各服务商的默认地址/模型、多个 Key 分别存在 `storage.local`、`storage.sync` 为空、清除 Key；
1. 服务商/模型/思考强度：侧边栏拉取 `/models`（过滤掉语音/向量/图像模型）并缓存、切换模型、各档位发出去的真实参数（百炼 qwen 的 `thinking_budget`、百炼 deepseek 的 `reasoning_effort`、DeepSeek 官方的 `thinking.type`、Gemini 的 `thinkingConfig.thinkingLevel`）、不支持的档位变灰、服务商拒绝参数时去参重试并提示、400 未开通/403 的错误提示、重新打开面板后记住选择；
2. JupyterLab（两种模式：普通 DOM 方式；`--LabApp.expose_app_in_browser=True` 时走 JupyterLab 命令 API）：
   检测 Notebook → 读取当前单元格和报错 → 生成代码预览 → 只插入不运行 → “插入并运行”必须先确认 → 运行并看到输出 → “修复报错” → 去掉工具栏后用快捷键兜底 → OpenAI 兼容接口；
3. Kaggle：`kaggle_top.html` 仿 www.kaggle.com 的顶层页面（结构来自真实已登录 Kaggle 的 DOM 抓取），里面的 `iframe name="notebook-editor-cells"` 来自**另一个站点**，嵌的是本机真实 JupyterLab 4（不暴露 `window.jupyterapp`）。用 Chromium 的 `--host-resolver-rules` 把 `www.kaggle.test`、`kkb-production.jupyter-proxy.kagglenet.test` 指向本机。验证：顶层回报“不是 Notebook”、侧边栏连到 iframe、读代码和报错、插入、确认后运行、修复报错、工具栏隐藏/按钮缺失时的兜底。

测试用的扩展副本由 `build_test_ext.py` 生成到 `/tmp/nbac-test-ext`，只在副本里额外允许 `127.0.0.1/localhost`、`*.kaggle.test`/`*.kagglenet.test`、`aistudio.baidu.test`、`modelscope.test`、`*.anruicloud.test` 和 `tabs` 权限，**发布用的 manifest.json 不变**。
4. 飞桨 AI Studio（BML Codelab）：`aistudio_proxy.py`（aiohttp）在 `aistudio.baidu.test:8770` 上仿真实路径 `/bj-cpu-01/user/123/456/home#codelab` 出一个宿主页，同源嵌 `#vscode-frame`（诱饵，里面还有嵌套 webview iframe）和 `#jupyterlab-frame`，后者经反向代理（含 WebSocket）连到一个 `base_url` 相同、**中文界面**（`jupyterlab-language-pack-zh-CN`）、不暴露全局 app 的真实 JupyterLab 4。验证：只连 `#jupyterlab-frame`、其他 frame 都回报“不是 Notebook”、读代码和报错、清华镜像提示、插入、确认后运行、修复报错、工具栏隐藏/缺失兜底。
   另外 `aistudio_monaco_fixture.html` 照抄真实 AI Studio 的单元格 DOM（中文标题的 `data-command` 单元格工具栏、Monaco 编辑器），用真实 `monaco-editor` 但删掉 `window.monaco`，验证从渲染行读代码、点工具栏插入、粘贴写入 Monaco、Shift+Enter 运行（运行是夹具里假的）。还验证外层项目编辑器 `/project/edit/…` 会提示去「专业开发」。

5. ModelScope Code Editor：`modelscope_server.py`（aiohttp，端口 8771）在 `modelscope.test` 上仿 `/code/workspace?instanceId=…` 外层页面，同源嵌 `iframe[title="notebook-ide"]` → `/notebook/main.html`（`modelscope_workbench.html`），另有同源 `extensionHostIframe.html` 诱饵和 `g.alicdn.test` 上的跨域 webview。工作台照抄真实抓取的 VS Code 原生 Notebook DOM（`.notebook-editor`、`monaco-list[aria-label="Notebook"]`、`.code-cell-row[data-index][aria-setsize]`、`aria-label="Add Code Cell"`、`.run-button-container a.codicon-notebook-execute`），单元格是真实 monaco-editor（`editContext: true`，即 `.native-edit-context` + 只读 `textarea.ime-text-area`），不暴露全局 monaco。“运行”是假的。验证：只连 notebook-ide frame、内核提示（`/usr/bin/python3` → 改选 `/usr/local/bin/python`）、读代码、输出读不到时让用户贴报错、点 + Code 插入并粘贴写入、确认后点 Execute Cell 运行、贴报错修复；`?readable=1` 输出在 DOM 里时直接读报错；`?nopaste=1` 粘贴被拦时改用 EditContext `textupdate`；`?nowrite=1` 全部写入方式失败时复制到剪贴板且不运行；`?empty=1` 和「我的 Notebook」页的提示。

6. 0.1.1 新增的兜底：普通 JupyterLab（没暴露 app）通过监听器钩子找到 Notebook widget 直接写模型；AI Studio 场景里拦掉所有输入事件、关掉监听器钩子，验证仍能通过 webpack 共享作用域里的 `@jupyterlab/notebook` 写模型；AI Studio Monaco 夹具（旧版 Monaco 的 `textarea.inputarea`）分别测 AMD loader 里的 Monaco API（默认）、只能粘贴（`?noamd=1`）、全都写不进（`?notyping=1`，应复制到剪贴板且不运行，诊断信息里有失败步骤）；ModelScope 夹具测悬停才出现、只响应 mousedown 的 + Code（`?hover=1`）、中文“代码”按钮（`?zh=1`）、没有按钮时按 B（`?nobuttons=1`）、只能写进当前空单元格（`?noinsert=1`），以及“复制诊断信息”（包含所有 frame、候选按钮，不含代码/输出/Key）。fallback 检查里设置 `window.__nbacNoModel = true` 来测 DOM 兜底路径。
7. 安睿云 JupyterLab：真实 JupyterLab 4 以 `--ServerApp.base_url=/instances/rgapi-one-click-test-0001/`（端口 8903，`allow_remote_access`）启动，域名 `jupyter.anruicloud.test` 指向本机。验证：`/instances/<id>/lab?reset` 启动器页面提示打开 Notebook、打开 `lab/tree/test.ipynb` 后识别为「安睿云 JupyterLab（jupyterlab，JupyterLab 模型，主页面）」、读代码和报错、清华镜像提示、插入（写模型）、确认后运行、修复报错。单元测试覆盖域名识别和 manifest 匹配规则。

侧边栏在测试里以独立弹窗（`index.html?tabId=…`）打开，界面和真正的侧边栏是同一个页面。

```bash
python3 -m venv .venv && .venv/bin/pip install jupyterlab ipykernel playwright aiohttp jupyterlab-language-pack-zh-CN
(cd tests && npm install)                          # monaco-editor，给 AI Studio Monaco 夹具用
.venv/bin/python -m playwright install chromium
export PATH=$PWD/.venv/bin:$PATH
xvfb-run -a -s "-screen 0 1920x1200x24" python tests/e2e_test.py   # 默认 xvfb 屏幕太小；有桌面可直接运行
node tests/unit_test.mjs                           # 纯函数单元测试
```

截图保存在 `/tmp/nbac-shots/`（可用 `NBAC_SHOT_DIR` 修改）。
