"""端到端测试：真实 JupyterLab + Chromium 加载扩展 + 本地模拟模型服务。
用法见 tests/README.md。退出码 0 = 全部通过。"""
import json, os, pathlib, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PY = sys.executable
MOCK_PORT = 8765
MOCK = f'http://127.0.0.1:{MOCK_PORT}'
KEY = 'test-key-not-secret'
SHOT_DIR = pathlib.Path(os.environ.get('NBAC_SHOT_DIR', '/tmp/nbac-shots'))
SHOT_DIR.mkdir(parents=True, exist_ok=True)
RESULTS = []

def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)
    return cond

def http_json(url):
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())

def last():
    return http_json(MOCK + '/last')

def wait_http(url, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2); return True
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('server not up: ' + url)

def make_notebook(root):
    nb = {
        'cells': [
            {'cell_type': 'code', 'metadata': {}, 'outputs': [], 'execution_count': None, 'source': 'x = 41\nprint(x + 1)'},
            {'cell_type': 'code', 'metadata': {}, 'outputs': [], 'execution_count': None, 'source': 'y = 1/0'},
        ],
        'metadata': {'kernelspec': {'name': 'python3', 'display_name': 'Python 3', 'language': 'python'}},
        'nbformat': 4, 'nbformat_minor': 5,
    }
    (root / 'test.ipynb').write_text(json.dumps(nb))

def start_lab(port, expose, frameable=False, base_url=None, zh=False, remote=False):
    root = pathlib.Path(tempfile.mkdtemp(prefix=f'nbac-lab-{port}-'))
    make_notebook(root)
    args = [PY, '-m', 'jupyterlab', '--no-browser', f'--port={port}', '--ip=127.0.0.1',
            "--ServerApp.token=", "--ServerApp.password=", '--ServerApp.disable_check_xsrf=True',
            f'--ServerApp.root_dir={root}', '--LabApp.news_url=', '--LabApp.check_for_updates_class=jupyterlab.NeverCheckForUpdate']
    if expose:
        args.append('--LabApp.expose_app_in_browser=True')
    if frameable:
        # 允许被另一个站点（仿 www.kaggle.com）用 iframe 嵌入，并接受仿 Kaggle 的 Host 头
        args += ['--ServerApp.allow_remote_access=True',
                 '--ServerApp.tornado_settings={"headers": {"Content-Security-Policy": "frame-ancestors *"}}']
    if base_url:
        args.append(f'--ServerApp.base_url={base_url}')
    if remote:
        # 接受仿安睿云的 Host 头（jupyter.anruicloud.test）
        args.append('--ServerApp.allow_remote_access=True')
    if zh:
        # 中文界面（需要 jupyterlab-language-pack-zh-CN），模拟 AI Studio 的中文 JupyterLab
        sd = pathlib.Path(tempfile.mkdtemp(prefix='nbac-labsettings-'))
        (sd / 'overrides.json').write_text(json.dumps({'@jupyterlab/translation-extension:plugin': {'locale': 'zh_CN'}}))
        args.append(f'--LabApp.app_settings_dir={sd}')
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_http(f'http://127.0.0.1:{port}{base_url or "/"}api/status')
    return p

def mock_providers(**over):
    """测试用设置：各服务商都指向本地模拟服务。"""
    prov = {
        'bailian': {'baseUrl': MOCK + '/compatible-mode/v1', 'apiKey': KEY, 'model': 'deepseek-v4.1-flash'},
        'deepseek': {'baseUrl': MOCK + '/deepseek', 'apiKey': KEY, 'model': 'deepseek-flash'},
        'gemini': {'baseUrl': MOCK + '/v1beta', 'apiKey': KEY, 'model': 'gemini-3.5-flash'},
        'custom': {'baseUrl': MOCK + '/compatible-mode/v1', 'apiKey': '', 'model': ''},
    }
    for k, v in over.items():
        prov[k].update(v)
    return prov

def open_panel(ctx, sw, tab_url_glob, size=(420, 1000)):
    tab_id = sw.evaluate("async (g) => (await chrome.tabs.query({url: g}))[0].id", tab_url_glob)
    ext_id = sw.url.split('/')[2]
    url = f'chrome-extension://{ext_id}/src/sidepanel/index.html?tabId={tab_id}'
    with ctx.expect_page() as pinfo:
        sw.evaluate("([u, w, h]) => chrome.windows.create({url: u, type: 'popup', width: w, height: h, left: 1110, top: 0})", [url, size[0], size[1]])
    panel = pinfo.value
    panel.wait_for_load_state()
    return panel

def set_storage(panel, **kw):
    panel.evaluate("(s) => chrome.storage.local.set(s)", kw)
    time.sleep(0.3)

def wait_status_ok(panel):
    panel.wait_for_selector('#status.ok', timeout=15000)
    return panel.inner_text('#status')

def bot_count(panel):
    return panel.eval_on_selector_all('.msg.bot:not(.pending)', 'e => e.length')

def ask(panel, text=None, fix=False):
    """发一条消息，返回 (代码, 回复全文, meta)；出错时代码为 ''。"""
    n = bot_count(panel)
    if fix:
        if text:
            panel.fill('#prompt', text)
        panel.click('#plusBtn'); panel.click('#fixError')
    else:
        panel.fill('#prompt', text)
        panel.click('#send')
    panel.wait_for_function(f"() => document.querySelectorAll('.msg.bot:not(.pending)').length > {n}", timeout=20000)
    m = panel.query_selector_all('.msg.bot:not(.pending)')[-1]
    ta = m.query_selector('.codeblock textarea')
    meta = m.query_selector('.meta')
    return (ta.input_value() if ta else ''), m.inner_text(), (meta.inner_text() if meta else '')

def last_bot(panel):
    return panel.query_selector_all('.msg.bot:not(.pending)')[-1]

def click_and_wait_result(panel, msg, selector):
    msg.evaluate("(m) => { m.querySelector('.result').textContent = ''; }")
    msg.query_selector(selector).click()
    panel.wait_for_function("(m) => /已插入|已写入|失败/.test(m.querySelector('.result').textContent)", arg=msg, timeout=30000)
    return msg.query_selector('.result').inner_text()

def lab_active_cell_text(page):
    return page.evaluate("""() => { const c = document.querySelector('.jp-Notebook .jp-Cell.jp-mod-active .cm-content');
        return c ? c.cmView.view.state.doc.toString() : null; }""")

def lab_cell_count(page):
    return page.eval_on_selector_all('.jp-Notebook .jp-Cell', 'els => els.length')

def lab_outputs(page):
    return page.eval_on_selector_all('.jp-Notebook .jp-OutputArea-output', 'els => els.map(e => e.innerText).join("\\n")')

def wait_text(page, text, timeout=30000):
    try:
        page.wait_for_function("(t) => document.body.innerText.includes(t)", arg=text, timeout=timeout); return True
    except Exception:
        return False

def prepare_lab_page(ctx, port):
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(f'http://127.0.0.1:{port}/lab/tree/test.ipynb')
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    time.sleep(3)  # 等内核启动
    page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')[0].click(); page.keyboard.press('Shift+Enter')
    page.wait_for_function("() => [...document.querySelectorAll('.jp-OutputArea-output')].some(e => e.innerText.includes('42'))", timeout=60000)
    page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')[1].click(); page.keyboard.press('Shift+Enter')
    page.wait_for_function("() => document.body.innerText.includes('ZeroDivisionError')", timeout=30000)
    page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')[1].click()  # 选中出错的单元格
    return page

def test_jupyterlab(ctx, sw, port, mode):
    print(f'\n=== JupyterLab ({mode}) on :{port} ===', flush=True)
    page = prepare_lab_page(ctx, port)
    panel = open_panel(ctx, sw, f'http://127.0.0.1:{port}/*')
    panel.set_viewport_size({'width': 420, 'height': 1000})
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True, modelCache={})
    status = wait_status_ok(panel)
    want = ('（jupyterlab，JupyterLab API，主页面）' in status) if mode == 'app' else ('（jupyterlab，JupyterLab 模型，主页面）' in status)
    check(f'[{mode}] 检测到 Notebook', want, status)
    n_cells = page.eval_on_selector_all('.jp-Notebook .jp-Cell', 'e => e.length')
    hw_ok = False
    for _ in range(60):
        hw_txt = panel.inner_text('#hw')
        if '已检测' in hw_txt and '核 CPU' in hw_txt and 'GB 内存' in hw_txt: hw_ok = True; break
        time.sleep(0.5)
    check(f'[{mode}] 连接后自动在内核里静默检测硬件（CPU 核数、内存），不新建单元格、不留输出',
          hw_ok and page.eval_on_selector_all('.jp-Notebook .jp-Cell', 'e => e.length') == n_cells and
          page.evaluate("() => !document.body.innerText.includes('NBAC_HW')"), hw_txt)

    # 1) 生成代码，带上下文（默认：百炼 + deepseek-v4.1-flash）
    code, _, meta = ask(panel, '配置好训练 YOLO11m 的环境并写好训练代码')
    check(f'[{mode}] 百炼默认模型生成代码并显示在对话里', 'NBAC_OK' in code and 'deepseek-v4.1-flash' in meta, meta)
    L = last()
    check(f'[{mode}] 请求发到百炼兼容接口，模型 deepseek-v4.1-flash', L.get('path') == '/compatible-mode/v1/chat/completions' and L.get('model') == 'deepseek-v4.1-flash')
    check(f'[{mode}] 读取当前单元格代码并发给模型', 'y = 1/0' in L.get('user', ''))
    check(f'[{mode}] 读取最近的报错输出并发给模型', 'ZeroDivisionError' in L.get('user', ''))
    check(f'[{mode}] 思考强度“默认”时不发送思考参数', not any(k in L['body'] for k in ('enable_thinking', 'reasoning_effort', 'thinking', 'thinking_budget')))

    # 2) 只插入，不运行
    msg = last_bot(panel)
    n0, out0 = lab_cell_count(page), lab_outputs(page)
    r = click_and_wait_result(panel, msg, '.act-insert')
    check(f'[{mode}] 插入到新单元格', lab_cell_count(page) == n0 + 1, r)
    if mode == 'dom':
        check('[dom] 没暴露 app 时通过监听器钩子找到 Notebook widget，直接写单元格模型', 'jupyterlab-model(listener-hook)' in r, r)
    txt = lab_active_cell_text(page) or ''
    check(f'[{mode}] 新单元格内容就是生成的代码', txt.strip() == code.strip(), txt[:60])
    time.sleep(1.5)
    check(f'[{mode}] 只插入时没有自动运行', lab_outputs(page) == out0)

    # 3) 插入并运行：必须先确认
    n1 = lab_cell_count(page)
    msg.query_selector('.act-run').click()
    check(f'[{mode}] 点“插入并运行”后先出现确认框', msg.query_selector('.confirm').is_visible())
    time.sleep(1)
    check(f'[{mode}] 确认前什么都没插入/运行', lab_cell_count(page) == n1)
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check(f'[{mode}] 确认后插入并运行，看到输出 “NBAC_OK 42 True”', wait_text(page, 'NBAC_OK 42 True'), r)

    # 4) 修复报错
    page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')[1].click()
    code, _, _ = ask(panel, fix=True)
    L = last()
    check(f'[{mode}] “修复报错”把代码和报错发给模型', 'ZeroDivisionError' in L.get('user', '') and '请修复' in L.get('user', ''))
    check(f'[{mode}] “修复报错”返回修好的单元格', 'NBAC_FIXED' in code)
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check(f'[{mode}] 修复后的单元格运行成功（输出 NBAC_FIXED 1.0）', wait_text(page, 'NBAC_FIXED 1.0'), r)

    if mode == 'dom':
        fallback_checks('dom', page, panel, msg, COUNT_JS, FIXED_N_JS)
    panel.close(); page.close()

STRIP_BUTTONS_JS = """() => {
  const kill = () => document.querySelectorAll('[data-command^="notebook:insert"], [data-command^="notebook:run"]').forEach(b => b.remove());
  kill(); new MutationObserver(kill).observe(document.body, {subtree: true, childList: true});
}"""

def fallback_checks(tag, target, panel, msg, count_js, done_js):
    """平台把工具栏藏起来 / 干脆没有这些按钮时的兜底路径（关掉模型写入，测 DOM 兜底）。"""
    target.evaluate("() => { window.__nbacNoModel = true; }")
    # a) 工具栏被 CSS 隐藏：隐藏的按钮仍然可用
    target.add_style_tag(content='.jp-Toolbar { display: none !important; }')
    n = target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js)
    k = target.evaluate(FIXED_COUNT_JS)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    ok = True
    try:
        target.wait_for_function(done_js, arg=k, timeout=30000)
    except Exception:
        ok = False
    check(f'[{tag}] 工具栏被隐藏时仍能插入并运行（用隐藏的工具栏按钮）', 'toolbar-button' in r and target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js) >= n + 1 and ok, r)
    # b) 页面上根本没有插入/运行按钮：快捷键（frame 有焦点时）或底部“添加单元格”，运行用 Shift+Enter
    target.evaluate(STRIP_BUTTONS_JS)
    n = target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js)
    k = target.evaluate(FIXED_COUNT_JS)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    ok = True
    try:
        target.wait_for_function(done_js, arg=k, timeout=30000)
    except Exception:
        ok = False
    check(f'[{tag}] 没有任何按钮时用快捷键/底部添加区插入并用 Shift+Enter 运行', ('keyboard' in r or 'notebook-footer' in r) and target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js) >= n + 1 and ok, r)

COUNT_JS = 'e => e.length'
OUT_COUNT_JS = "(t) => [...document.querySelectorAll('.jp-OutputArea-output')].filter(e => e.textContent.includes(t)).length"
BLOCK_TYPING_JS = """() => {
  window.__nbacBlockTyping = true;
  for (const t of ['paste', 'beforeinput', 'input', 'textInput', 'keydown', 'keypress', 'compositionend']) {
    document.addEventListener(t, (e) => { if (window.__nbacBlockTyping) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }
}"""
# 用 textContent 数输出区：JupyterLab 4 的 content-visibility 窗口化会让屏幕外单元格不出现在 innerText 里
FIXED_COUNT_JS = "() => [...document.querySelectorAll('.jp-OutputArea-output')].filter(e => e.textContent.includes('NBAC_FIXED 1.0')).length"
FIXED_N_JS = "(n) => (" + FIXED_COUNT_JS + ")() > n"

def menu_levels(panel):
    panel.click('#thinkBtn')
    lv = panel.eval_on_selector_all('#thinkOptions .menu-item', 'bs => bs.map(b => [b.dataset.level, !b.disabled])')
    panel.click('#chat')
    return {k: v for k, v in lv}

def pick_level(panel, level):
    panel.click('#thinkBtn')
    panel.click(f'#thinkOptions [data-level="{level}"]')
    time.sleep(0.3)

def pick_model(panel, model, provider=None):
    panel.click('#modelBtn')
    if provider:
        panel.select_option('#providerSelect', provider)
        time.sleep(0.5)
    panel.wait_for_function("() => document.querySelectorAll('#modelListBox .menu-item').length > 0 && !/正在获取/.test(document.getElementById('modelHint').textContent)", timeout=10000)
    items = panel.eval_on_selector_all('#modelListBox .menu-item', 'bs => bs.map(b => b.dataset.model)')
    hint = panel.inner_text('#modelHint')
    if model in items:
        panel.click(f'#modelListBox [data-model="{model}"]')
    else:
        panel.fill('#modelInput', model); panel.press('#modelInput', 'Enter')
    time.sleep(0.3)
    panel.click('#chat')
    return items, hint

def test_models_and_thinking(ctx, sw):
    print('\n=== 服务商 / 模型列表 / 思考强度 ===', flush=True)
    page = ctx.new_page()
    page.goto(MOCK + '/blank.html')
    panel = open_panel(ctx, sw, MOCK + '/blank.html')
    panel.evaluate("() => chrome.storage.local.clear()")
    panel.reload(); time.sleep(0.8)
    check('[model] 首次安装默认服务商=阿里云百炼，模型=deepseek-v4.1-flash', panel.inner_text('#modelLabel') == 'deepseek-v4.1-flash'
          and panel.evaluate("() => document.getElementById('modelBtn').title").startswith('阿里云百炼'), panel.inner_text('#modelLabel'))
    set_storage(panel, providers=mock_providers(), active='bailian', includeContext=False)

    items, hint = pick_model(panel, 'qwen3.8-max')
    check('[model] 侧边栏用 Key 拉取 /models 列表', 'qwen3.8-max' in items and 'kimi-k3' in items and 'MiniMax/MiniMax-M3' in items, hint)
    check('[model] 过滤掉语音/向量/图像模型', not any(x in items for x in ('paraformer-v2', 'qwen-tts-latest', 'text-embedding-v4', 'wanx2.1-t2i-turbo')), ','.join(items))
    check('[model] 切换模型后按钮显示新模型', panel.inner_text('#modelLabel') == 'qwen3.8-max')
    cache = panel.evaluate("() => chrome.storage.local.get('modelCache')")['modelCache']
    check('[model] 模型列表已缓存', 'qwen3.8-max' in cache.get('bailian', {}).get('models', []))

    lv = menu_levels(panel)
    check('[think] qwen 支持 关闭/低/中/高/最高', all(lv[k] for k in ('off', 'low', 'medium', 'high', 'max')), str(lv))
    pick_level(panel, 'high')
    ask(panel, '写个训练脚本')
    b = last()['body']
    check('[think] 百炼 qwen “高” → enable_thinking=true, thinking_budget=16384', b.get('enable_thinking') is True and b.get('thinking_budget') == 16384,
          json.dumps({k: b.get(k) for k in ('enable_thinking', 'thinking_budget')}))

    pick_model(panel, 'deepseek-v4.1-flash')
    lv = menu_levels(panel)
    check('[think] 百炼 deepseek-v4.1-flash 隐藏“中”档', lv['medium'] is False and lv['low'] and lv['max'], str(lv))
    pick_level(panel, 'max')
    ask(panel, '写个训练脚本')
    b = last()['body']
    check('[think] 百炼 deepseek “最高” → enable_thinking=true, reasoning_effort=max', b.get('enable_thinking') is True and b.get('reasoning_effort') == 'max')
    pick_level(panel, 'off')
    ask(panel, '写个训练脚本')
    b = last()['body']
    check('[think] 百炼 “关闭” → enable_thinking=false', b.get('enable_thinking') is False and 'reasoning_effort' not in b)

    pick_model(panel, 'kimi-k3')
    lv = menu_levels(panel)
    check('[think] kimi-k3 只能 关闭/高（不支持预算）', lv['off'] and lv['high'] and not lv['low'] and not lv['medium'] and not lv['max'], str(lv))

    # 拒绝思考参数 → 去参重试 + 提示
    pick_model(panel, 'no-think-model')
    pick_level(panel, 'high')
    http_json(MOCK + '/reset')
    code, _, _ = ask(panel, '写个训练脚本')
    log = http_json(MOCK + '/log')
    check('[think] 模型拒绝思考参数时自动去掉参数重试', 'NBAC_OK' in code and len(log) == 2 and 'enable_thinking' in log[0]['body'] and 'enable_thinking' not in log[1]['body'])
    check('[think] 重试后显示提示', panel.is_visible('#notice') and '思考强度' in panel.inner_text('#notice'), panel.inner_text('#notice'))

    # 未开通 / 403 错误要讲清楚
    pick_model(panel, 'MiniMax/MiniMax-M3')
    _, text, _ = ask(panel, '写个训练脚本')
    check('[model] 带“/”第三方模型 400 未开通 → 明确提示', '还没有开通' in text, text[:90])
    pick_model(panel, 'old-model-403')
    _, text, _ = ask(panel, '写个训练脚本')
    check('[model] 403 → 明确提示没有权限', '没有权限' in text, text[:90])

    # DeepSeek 官方
    items, _ = pick_model(panel, 'deepseek-flash', provider='deepseek')
    check('[deepseek] 切换服务商后拉取 DeepSeek 模型列表', 'deepseek-flash' in items, ','.join(items))
    pick_level(panel, 'off')
    ask(panel, '写个训练脚本')
    L = last()
    check('[deepseek] “关闭” → thinking.type=disabled', L['path'] == '/deepseek/chat/completions' and L['body'].get('thinking') == {'type': 'disabled'})
    pick_level(panel, 'low')
    ask(panel, '写个训练脚本')
    b = last()['body']
    check('[deepseek] “低” → thinking.type=enabled + reasoning_effort=low', b.get('thinking') == {'type': 'enabled'} and b.get('reasoning_effort') == 'low')

    # Gemini
    items, _ = pick_model(panel, 'gemini-3.5-flash', provider='gemini')
    check('[gemini] models.list 只保留 generateContent 模型', 'gemini-3.5-flash' in items and 'gemini-embedding-001' not in items and 'imagen-4.0-generate-001' not in items, ','.join(items))
    lv = menu_levels(panel)
    check('[gemini] 3.5 Flash 没有“最高”档', lv['max'] is False and lv['low'], str(lv))
    pick_level(panel, 'low')
    code, _, _ = ask(panel, '写个训练脚本')
    L = last()
    check('[gemini] “低” → generationConfig.thinkingConfig.thinkingLevel=low，模型 gemini-3.5-flash',
          'gemini-3.5-flash:generateContent' in L['path'] and L['body']['generationConfig'].get('thinkingConfig') == {'thinkingLevel': 'low'} and 'NBAC_OK' in code)

    # 记住上次选择
    panel.reload(); time.sleep(0.8)
    st = panel.evaluate("() => chrome.storage.local.get(['active','thinking'])")
    check('[memory] 重新打开面板后记住服务商/模型/思考强度',
          panel.inner_text('#modelLabel') == 'gemini-3.5-flash' and panel.inner_text('#thinkLabel') == '低' and st == {'active': 'gemini', 'thinking': 'low'}, str(st))
    panel.close(); page.close()

KAGGLE_TOP = 'http://www.kaggle.test:%d/code/someone/yolo11m-rdd2022/edit' % MOCK_PORT

def kaggle_frame(page):
    return page.frame(name='notebook-editor-cells')

def test_kaggle(ctx, sw):
    """仿真实 Kaggle：顶层 www.kaggle.test（仿 kaggle.com 的 React 工具栏，无单元格）+
    跨站 iframe kkb-production.jupyter-proxy.kagglenet.test:8901（真实 JupyterLab 4，不暴露全局 app）。"""
    print('\n=== Kaggle（顶层页面 + 跨站 JupyterLab iframe） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(KAGGLE_TOP)
    page.wait_for_function("() => window.frames['notebook-editor-cells']", timeout=20000)
    fr = None
    for _ in range(120):
        fr = kaggle_frame(page)
        if fr and fr.url.startswith('http://kkb-production.jupyter-proxy.kagglenet.test'):
            try:
                if fr.query_selector('.jp-Notebook .jp-Cell .cm-content'):
                    break
            except Exception:
                pass
        time.sleep(0.5)
    check('[kaggle] iframe 来自另一个站点并加载了 JupyterLab', fr is not None and fr.url.startswith('http://kkb-production.jupyter-proxy.kagglenet.test:8901/'), fr.url if fr else None)
    check('[kaggle] iframe 里没有暴露 window.jupyterapp', fr.evaluate("() => !window.jupyterapp && !window.jupyterlab"))
    time.sleep(3)
    cells = lambda: fr.query_selector_all('.jp-Notebook .jp-Cell .cm-content')
    cells()[0].click(); page.keyboard.press('Shift+Enter')
    fr.wait_for_function("() => [...document.querySelectorAll('.jp-OutputArea-output')].some(e => e.innerText.includes('42'))", timeout=60000)
    cells()[1].click(); page.keyboard.press('Shift+Enter')
    fr.wait_for_function("() => document.body.innerText.includes('ZeroDivisionError')", timeout=30000)
    cells()[1].click()

    panel = open_panel(ctx, sw, 'http://www.kaggle.test:%d/*' % MOCK_PORT)
    panel.set_viewport_size({'width': 420, 'height': 1000})
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    frames = panel.evaluate("() => document.getElementById('status').title")
    check('[kaggle] 连上的是 iframe 里的 JupyterLab（不是顶层 kaggle 页面）', 'Kaggle' in status and 'jupyterlab' in status and '内嵌 frame' in status, status)
    check('[kaggle] 顶层 www.kaggle 页面回报“不是 Notebook”', '(top): 不是 Notebook' in frames, frames.replace('\n', ' | '))

    code, _, _ = ask(panel, '配置好训练 YOLO11m 的环境')
    L = last()
    check('[kaggle] 从 iframe 读取单元格代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''))
    check('[kaggle] 系统提示按海外平台（不加清华镜像）', 'tsinghua' not in L.get('system', '') and 'Kaggle' in L.get('system', ''))

    msg = last_bot(panel)
    n0 = fr.eval_on_selector_all('.jp-Notebook .jp-Cell', 'e => e.length')
    r = click_and_wait_result(panel, msg, '.act-insert')
    txt = fr.evaluate("() => { const c = document.querySelector('.jp-Notebook .jp-Cell.jp-mod-active .cm-content'); return c ? c.cmView.view.state.doc.toString() : ''; }")
    check('[kaggle] 在 iframe 里插入新单元格并写入代码', fr.eval_on_selector_all('.jp-Notebook .jp-Cell', 'e => e.length') == n0 + 1 and txt.strip() == code.strip(), r)
    time.sleep(1)
    check('[kaggle] 只插入时没有运行', 'NBAC_OK 42' not in fr.inner_text('body').replace(code, ''))

    msg.query_selector('.act-run').click()
    check('[kaggle] 运行前要确认', msg.query_selector('.confirm').is_visible())
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[kaggle] 确认后在 iframe 里插入并运行，输出 NBAC_OK 42 True', wait_text(fr, 'NBAC_OK 42 True'), r)
    check('[kaggle] 运行走 JupyterLab 模型 + 内核会话，并确认真的开始执行了', '运行：jupyterlab-model' in r, r)

    cells()[1].click()
    code, _, _ = ask(panel, fix=True)
    L = last()
    check('[kaggle] 修复报错：把 iframe 里的报错发给模型', '请修复' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', '') and 'NBAC_FIXED' in code)
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[kaggle] 修复后的单元格在 iframe 里运行成功（NBAC_FIXED 1.0）', wait_text(fr, 'NBAC_FIXED 1.0'), r)

    # Kaggle 的 iframe 里工具栏可能被隐藏，或者根本没有这些按钮
    fallback_checks('kaggle', fr, panel, msg, COUNT_JS, FIXED_N_JS)
    page.screenshot(path=str(SHOT_DIR / 'kaggle-notebook.png'))
    panel.screenshot(path=str(SHOT_DIR / 'kaggle-panel.png'))
    panel.close(); page.close()

AIS = 'http://aistudio.baidu.test:%d' % 8770
AIS_HOME = AIS + '/bj-cpu-01/user/123/456/home#codelab'

def wait_frame(page, pred, what, timeout=60):
    for _ in range(int(timeout * 2)):
        for f in page.frames:
            try:
                if pred(f):
                    return f
            except Exception:
                pass
        time.sleep(0.5)
    raise RuntimeError('frame not found: ' + what)

def test_aistudio(ctx, sw):
    """仿 BML Codelab：同源宿主页 + #vscode-frame 诱饵（含嵌套 iframe）+ #jupyterlab-frame（真实中文 JupyterLab 4，经同源反向代理，不暴露全局 app）。"""
    print('\n=== 飞桨 AI Studio（BML Codelab 宿主页 + #jupyterlab-frame + VS Code 诱饵） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(AIS_HOME)
    fr = wait_frame(page, lambda f: f.url.startswith(AIS + '/bj-cpu-01/user/123/456/lab') and f.query_selector('.jp-Notebook .jp-Cell .cm-content'), 'jupyterlab-frame')
    check('[aistudio] #jupyterlab-frame 与宿主页同源', page.evaluate("() => !!document.getElementById('jupyterlab-frame').contentDocument"))
    check('[aistudio] 页面里有 VS Code 诱饵 frame 和嵌套 webview', len([f for f in page.frames if '/vscode/' in f.url]) >= 2, ' | '.join(f.url for f in page.frames))
    check('[aistudio] iframe 里没有暴露 window.jupyterapp', fr.evaluate("() => !window.jupyterapp && !window.jupyterlab"))
    zh = fr.evaluate("() => (document.querySelector('[data-command=\"notebook:insert-cell-below\"]') || {}).title || ''")
    check('[aistudio] JupyterLab 是中文界面（按钮标题为中文）', any('\u4e00' <= ch <= '\u9fff' for ch in zh), zh)
    time.sleep(3)
    cells = lambda: fr.query_selector_all('.jp-Notebook .jp-Cell .cm-content')
    cells()[0].click(); page.keyboard.press('Shift+Enter')
    fr.wait_for_function("() => [...document.querySelectorAll('.jp-OutputArea-output')].some(e => e.innerText.includes('42'))", timeout=60000)
    cells()[1].click(); page.keyboard.press('Shift+Enter')
    fr.wait_for_function("() => document.body.innerText.includes('ZeroDivisionError')", timeout=30000)
    cells()[1].click()

    panel = open_panel(ctx, sw, AIS + '/bj-cpu-01/*')
    panel.set_viewport_size({'width': 420, 'height': 1000})
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    frames = panel.evaluate("() => document.getElementById('status').title")
    check('[aistudio] 连上 #jupyterlab-frame（平台识别为飞桨 AI Studio）', '飞桨 AI Studio' in status and 'jupyterlab' in status and '内嵌 frame' in status, status)
    chosen = [l for l in frames.split('\n') if 'jupyterlab ' in l]
    check('[aistudio] 宿主页、VS Code frame 和 webview 都回报“不是 Notebook”', len(chosen) == 1 and '/456/lab' in chosen[0]
          and all('不是 Notebook' in l for l in frames.split('\n') if l not in chosen), frames.replace('\n', ' | '))

    code, _, _ = ask(panel, '配置好训练 YOLO11m 的环境')
    L = last()
    check('[aistudio] 读取单元格代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''))
    check('[aistudio] 系统提示带清华镜像（国内平台）', 'pypi.tuna.tsinghua.edu.cn' in L.get('system', ''))
    msg = last_bot(panel)
    n0 = fr.eval_on_selector_all('.jp-Notebook .jp-Cell', COUNT_JS)
    # 模拟真实 AI Studio 里“往编辑器打字/粘贴都失败”：拦掉所有输入事件，并且不用监听器钩子（只靠 webpack 运行时找模型）
    fr.evaluate(BLOCK_TYPING_JS)
    fr.evaluate("() => { window.__nbacNoListenerHook = true; }")
    r = click_and_wait_result(panel, msg, '.act-insert')
    txt = fr.evaluate("() => { const c = document.querySelector('.jp-Notebook .jp-Cell.jp-mod-active .cm-content'); return c ? c.cmView.view.state.doc.toString() : ''; }")
    check('[aistudio] 打字/粘贴全被拦掉时，仍通过 JupyterLab 模型（webpack 共享作用域）插入并写入代码', fr.eval_on_selector_all('.jp-Notebook .jp-Cell', COUNT_JS) == n0 + 1 and txt.strip() == code.strip() and 'jupyterlab-model(share-scope' in r, r)
    fr.evaluate("() => { window.__nbacBlockTyping = false; window.__nbacNoListenerHook = false; }")
    msg.query_selector('.act-run').click()
    check('[aistudio] 运行前要确认', msg.query_selector('.confirm').is_visible())
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[aistudio] 确认后插入并运行，输出 NBAC_OK 42 True', wait_text(fr, 'NBAC_OK 42 True'), r)
    cells()[1].click()
    code, _, _ = ask(panel, fix=True)
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[aistudio] 修复报错后运行成功（NBAC_FIXED 1.0）', 'NBAC_FIXED' in code and wait_text(fr, 'NBAC_FIXED 1.0'), r)
    fallback_checks('aistudio', fr, panel, msg, COUNT_JS, FIXED_N_JS)
    page.screenshot(path=str(SHOT_DIR / 'aistudio-notebook.png'))
    panel.screenshot(path=str(SHOT_DIR / 'aistudio-panel.png'))
    panel.close(); page.close()

def aistudio_monaco_case(ctx, sw, query, tag):
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(AIS + '/bj-cpu-01/user/123/789/home' + query + '#codelab')
    fr = wait_frame(page, lambda f: '/789/lab' in f.url and f.evaluate('() => !!window.__fixtureReady'), 'monaco fixture', 30)
    panel = open_panel(ctx, sw, AIS + '/bj-cpu-01/user/123/789/*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    return page, fr, panel, status

MONACO_ACTIVE_JS = "() => { const c = document.querySelector('.jp-Cell.jp-mod-active'); return c ? window.__fixtureMonaco.editor.getEditors().find(e => c.contains(e.getDomNode())).getValue() : ''; }"

def test_aistudio_monaco(ctx, sw):
    """AI Studio 的单元格编辑器是 Monaco（真实页面是旧版 Monaco：隐藏的 textarea.inputarea）：
    用照抄真实 DOM 的夹具 + 真实 monaco-editor（不暴露 window.monaco）测读写。运行是假的。"""
    print('\n=== 飞桨 AI Studio Monaco 单元格（真实 DOM 结构夹具，运行为假） ===', flush=True)
    page, fr, panel, status = aistudio_monaco_case(ctx, sw, '', 'monaco')
    check('[monaco] 夹具里没有全局 window.monaco，编辑器用 textarea.inputarea（和真实页面一致）', fr.evaluate("() => !window.monaco && !!document.querySelector('.monaco-editor textarea.inputarea') && !document.querySelector('.native-edit-context')"))
    check('[monaco] 检测到 Notebook', '飞桨 AI Studio' in status and 'jupyterlab' in status, status)
    code, _, _ = ask(panel, fix=True)
    L = last()
    check('[monaco] 从 Monaco 单元格读到代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''), L.get('user', '')[:120])
    msg = last_bot(panel)
    n0 = fr.eval_on_selector_all('.jp-Cell', COUNT_JS)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    val = fr.evaluate(MONACO_ACTIVE_JS)
    check('[monaco] 用中文标题的单元格工具栏按钮插入，并通过 AMD loader 里的 Monaco API 写入（内容完全一致）', fr.eval_on_selector_all('.jp-Cell', COUNT_JS) == n0 + 1 and val.strip() == code.strip() and 'monaco-api(amd-require)' in r, r + ' | ' + val[:80])
    check('[monaco] Shift+Enter 运行（夹具的假运行）', wait_text(fr, 'NBAC_FIXED 1.0', 10000))
    page.screenshot(path=str(SHOT_DIR / 'aistudio-monaco.png'))
    panel.close(); page.close()

    # 没有 AMD loader：只能对 textarea 发粘贴事件
    page, fr, panel, status = aistudio_monaco_case(ctx, sw, '?noamd=1', 'monaco-noamd')
    code, _, _ = ask(panel, fix=True)
    msg = last_bot(panel)
    r = click_and_wait_result(panel, msg, '.act-insert')
    val = fr.evaluate(MONACO_ACTIVE_JS)
    check('[monaco] 拿不到 Monaco API 时对 textarea.inputarea 粘贴写入（内容完全一致）', val.strip() == code.strip() and 'monaco-paste' in r, r)
    panel.close(); page.close()

    # 打字/粘贴全失败（真实页面报“写入 Monaco 编辑器失败”的情况）：提示并复制到剪贴板，不运行
    page, fr, panel, status = aistudio_monaco_case(ctx, sw, '?notyping=1', 'monaco-notyping')
    code, _, _ = ask(panel, fix=True)
    msg = last_bot(panel)
    k = fr.evaluate("() => document.body.innerText.split('NBAC_FIXED 1.0').length")
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    time.sleep(1)
    notice = panel.inner_text('#notice') if panel.is_visible('#notice') else ''
    ran = fr.evaluate("() => document.body.innerText.split('NBAC_FIXED 1.0').length") > k
    check('[monaco] 所有写入方式都失败时：提示失败、代码复制到剪贴板、不运行', '插入失败' in r and '剪贴板' in r and '剪贴板' in notice and not ran, r + ' | ' + notice)
    # 诊断信息里能看到失败的步骤
    data = panel.evaluate("() => copyDiagnosticsForTest()")
    fr_diag = [f for f in data['frames'] if '/789/lab' in (f.get('url') or '')]
    le = fr_diag[0].get('lastError') if fr_diag else None
    check('[monaco] 诊断信息里记录了最近一次写入失败的步骤', bool(le) and 'Monaco' in le.get('message', '') and any(s.get('step') == 'monaco-write-failed' for s in le.get('steps', [])), json.dumps(le, ensure_ascii=False)[:300])
    panel.close(); page.close()

def test_aistudio_outer(ctx, sw):
    print('\n=== 飞桨 AI Studio 外层项目编辑器 ===', flush=True)
    page = ctx.new_page()
    page.goto(AIS + '/project/edit/10871106')
    panel = open_panel(ctx, sw, AIS + '/project/*')
    panel.wait_for_selector('#status.bad', timeout=15000)
    st = panel.inner_text('#status')
    check('[outer] 外层编辑器提示去「专业开发」打开 BML Codelab', '请点击「专业开发」打开 BML Codelab 后使用' in st, st)
    panel.close(); page.close()

MS = 'http://modelscope.test:8771'

def ms_open(ctx, sw, query='', auto_probe=False):
    page = ctx.new_page()
    page.set_viewport_size({'width': 1100, 'height': 900})
    page.goto(MS + '/code/workspace?instanceId=dsw-test&resourceType=free&acceleratorType=CPU' + query)
    fr = wait_frame(page, lambda f: '/notebook/main.html' in f.url and f.evaluate('() => !!window.__fixtureReady'), 'notebook-ide', 30)
    # 这些用例按单元格位置检查，先标记“已自动检测过硬件”，避免自动插入检测单元格打乱位置
    if auto_probe:
        sw.evaluate("() => chrome.storage.local.remove(['nbacHwAutoTried2', 'nbacHardware'])")
    else:
        sw.evaluate("(k) => chrome.storage.local.set({nbacHwAutoTried2: {[k]: Date.now()}})", MS + '/code/workspace')
    panel = open_panel(ctx, sw, MS + '/code/*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    return page, fr, panel

MS_CELLS_JS = "() => window.__fixtureCells.map(c => ({i: +c.row.dataset.index, focused: c.row.classList.contains('focused'), code: c.ed.getValue()}))"

def test_modelscope_autoprobe(ctx, sw):
    """ModelScope 输出在跨域 webview 里读不到：自动插入检测单元格并运行，内核用 set_next_input 把结果写回单元格，扩展从单元格文字里读。
    夹具不跑 Python，这里手动模拟内核写回。"""
    print('\n=== ModelScope 自动检测硬件 ===', flush=True)
    page, fr, panel = ms_open(ctx, sw, auto_probe=True)
    wait_status_ok(panel)
    idx = None
    for _ in range(40):
        cells = fr.evaluate(MS_CELLS_JS)
        hit = [c for c in cells if '_nbac_probe(replace=True)\ndel _nbac_probe' in c['code']]
        if hit: idx = hit[0]['i']; break
        time.sleep(0.5)
    check('[ms-auto] 连接后自动插入检测单元格（带 replace=True 写回结果）', idx is not None, str(idx))
    if idx is not None:
        time.sleep(4)  # 等插入校验和运行完成，再模拟内核写回
        fr.evaluate("(i) => window.__fixtureCells.find(c => +c.row.dataset.index === i).ed.setValue('    # 硬件检测结果\\n    # NBAC_HW {\"vendor\":\"nvidia\",\"devices\":[{\"name\":\"NVIDIA A10\",\"vram_gb\":22.0}],\"cpu_count\":8,\"ram_gb\":30.0,\"torch\":\"2.3\"}')", idx)
    ok = False
    for _ in range(40):
        hw = panel.inner_text('#hw')
        if 'NVIDIA A10' in hw and '8 核 CPU' in hw and '30 GB 内存' in hw and '已检测' in hw: ok = True; break
        time.sleep(0.5)
    notice = panel.inner_text('#notice') if panel.is_visible('#notice') else ''
    txt = fr.evaluate("(i) => { const c = window.__fixtureCells.find(c => +c.row.dataset.index === i); return c ? c.ed.getValue().slice(0, 80) + ' || ' + c.row.innerText.slice(0, 120) : 'nocell'; }", idx) if idx is not None else ''
    check('[ms-auto] 从单元格文字读回检测结果：显卡型号、显存、CPU 核数、内存', ok, hw + ' | ' + notice + ' | ' + txt)
    panel.close(); page.close()

def test_modelscope(ctx, sw):
    """ModelScope 免费 CPU 实例的 Code Editor：外层页面同源嵌 VS Code 工作台（iframe[title=notebook-ide]），
    .ipynb 用 VS Code 原生 Notebook 编辑器 + Monaco（EditContext）。夹具照抄真实 DOM，Monaco 是真的，运行是假的。"""
    print('\n=== ModelScope Code Editor（VS Code 原生 Notebook，真实 DOM 结构夹具） ===', flush=True)
    page, fr, panel = ms_open(ctx, sw)
    status = wait_status_ok(panel)
    frames = panel.evaluate("() => document.getElementById('status').title")
    check('[ms] 连上 notebook-ide frame（平台 ModelScope，vscode-notebook）', 'ModelScope' in status and 'vscode-notebook' in status and '内嵌 frame' in status, status)
    lines = frames.split('\n')
    chosen = [l for l in lines if 'vscode-notebook' in l]
    check('[ms] 外层页面和 extensionHost frame 回报“不是 Notebook”，跨域 webview 不注入', len(chosen) == 1 and '/notebook/main.html' in chosen[0]
          and all('不是 Notebook' in l for l in lines if l not in chosen) and not any('alicdn' in l for l in lines), frames.replace('\n', ' | '))
    check('[ms] 识别到真实 Monaco 用的是 EditContext（.native-edit-context，没有 textarea.inputarea）',
          fr.evaluate("() => !!document.querySelector('.code-cell-row .native-edit-context') && !document.querySelector('.code-cell-row textarea.inputarea') && !window.monaco"))
    notice = panel.inner_text('#notice') if panel.is_visible('#notice') else ''
    check('[ms] 内核是 /usr/bin/python3 时提示改选 /usr/local/bin/python', '/usr/local/bin/python' in notice and 'ipykernel' in notice, notice)

    code, txt, _ = ask(panel, '用 pandas 读一个 csv')
    L = last()
    check('[ms] 读到当前单元格代码（Monaco 渲染行）', 'y = 1/0' in L.get('user', ''), L.get('user', '')[:120])
    check('[ms] 系统提示带清华镜像（国内平台）', 'pypi.tuna.tsinghua.edu.cn' in L.get('system', ''))
    _, txt, _ = ask(panel, fix=True)
    check('[ms] 输出在跨域 webview 里读不到时，修复报错提示把报错贴进输入框', '读不到报错文字' in txt, txt[:120])

    msg = last_bot(panel)
    # 用上一条正常回复的代码块来插入
    msg = [m for m in panel.query_selector_all('.msg.bot:not(.pending)') if m.query_selector('.act-insert')][-1]
    r = click_and_wait_result(panel, msg, '.act-insert')
    cells = fr.evaluate(MS_CELLS_JS)
    new = [c for c in cells if c['focused']]
    check('[ms] 点当前单元格下方的“+ Code”插入，并通过粘贴写入 Monaco（内容完全一致）',
          len(cells) == 3 and new and new[0]['i'] == 2 and new[0]['code'].strip() == code.strip() and 'cell-toolbar+monaco-paste' in r, r + ' | ' + json.dumps(cells, ensure_ascii=False)[:200])
    notice = panel.inner_text('#notice') if panel.is_visible('#notice') else ''
    check('[ms] 插入后仍提示内核问题', '/usr/local/bin/python' in notice, notice)

    fr.click('a.codicon-notebook-kernel-select')  # 模拟用户改选 /usr/local/bin/python
    panel.click('#plusBtn'); panel.click('#refresh')
    wait_status_ok(panel); time.sleep(0.5)
    check('[ms] 换好内核后提示消失', not panel.is_visible('#notice'), panel.inner_text('#notice'))
    msg.query_selector('.act-run').click()
    check('[ms] 运行前要确认', msg.query_selector('.confirm').is_visible())
    n_out = fr.evaluate("() => window.__fixtureOutputs.length")
    r = click_and_wait_result(panel, msg, '.act-confirm')
    outs = fr.evaluate("() => window.__fixtureOutputs")
    check('[ms] 确认后插入并用单元格的 Execute Cell 按钮运行（NBAC_OK 42 True）',
          len(outs) == n_out + 1 and outs[-1]['text'] == 'NBAC_OK 42 True' and outs[-1]['index'] == 3, r + ' | ' + json.dumps(outs, ensure_ascii=False)[:200])
    check('[ms] 运行后新单元格的执行序号变了（夹具仿 VS Code 的 [*]/[N]）', '运行：execute-button' in r and fr.evaluate("() => /\\[\\d+\\]|\\[\\*\\]/.test(document.querySelector('.code-cell-row[data-index=\"3\"] .cell-execution-order').textContent)"), r)

    # 把报错贴进输入框再修复
    # 选中出错的单元格（真实页面里输出 webview 可能盖在单元格上，这里直接派发 mousedown + 聚焦编辑器）
    fr.evaluate("""() => { const r = document.querySelector('.code-cell-row[data-index="1"]'); r.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); r.querySelector('.native-edit-context').focus(); }""")
    code, _, _ = ask(panel, 'ZeroDivisionError: division by zero', fix=True)
    L = last()
    check('[ms] 用户贴进来的报错作为报错输出发给模型', 'ZeroDivisionError' in L.get('user', '') and 'y = 1/0' in L.get('user', '') and 'NBAC_FIXED' in code, L.get('user', '')[:160])
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    outs = fr.evaluate("() => window.__fixtureOutputs")
    cells = fr.evaluate(MS_CELLS_JS)
    check('[ms] 修复代码插在出错单元格下方并运行（NBAC_FIXED 1.0）', outs[-1]['text'] == 'NBAC_FIXED 1.0' and outs[-1]['index'] == 2 and len(cells) == 5, r)
    page.screenshot(path=str(SHOT_DIR / 'modelscope-notebook.png'))
    panel.screenshot(path=str(SHOT_DIR / 'modelscope-panel.png'))
    panel.close(); page.close()

    # 输出能读到时（DOM 里的文字），修复报错直接读取
    page, fr, panel = ms_open(ctx, sw, '&readable=1')
    wait_status_ok(panel)
    code, _, _ = ask(panel, fix=True)
    L = last()
    check('[ms] 输出在 DOM 里时直接读到报错', 'ZeroDivisionError' in L.get('user', '') and 'NBAC_FIXED' in code, L.get('user', '')[:160])
    panel.close(); page.close()

    # 粘贴被拦掉：改用 EditContext 的 textupdate 写入
    page, fr, panel = ms_open(ctx, sw, '&nopaste=1&kernel=local')
    wait_status_ok(panel)
    code, _, _ = ask(panel, '写一个多行带缩进的函数')
    msg = last_bot(panel)
    r = click_and_wait_result(panel, msg, '.act-insert')
    new = [c for c in fr.evaluate(MS_CELLS_JS) if c['focused']]
    check('[ms] 粘贴无效时用 EditContext textupdate 写入（缩进不变、不多括号）', new and new[0]['code'].strip() == code.strip() and 'monaco-editcontext' in r, r)
    panel.close(); page.close()

    # 所有写入方式都无效：代码复制到剪贴板 + 提示，不运行
    page, fr, panel = ms_open(ctx, sw, '&nowrite=1&kernel=local')
    wait_status_ok(panel)
    ask(panel, '随便写点')
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    outs = fr.evaluate("() => window.__fixtureOutputs")
    notice = panel.inner_text('#notice') if panel.is_visible('#notice') else ''
    check('[ms] 写不进编辑器时提示并把代码复制到剪贴板，不运行', '插入失败' in r and ('剪贴板' in r or '复制' in r) and '自动写入单元格失败' in notice and not outs, r + ' | ' + notice)
    panel.close(); page.close()

    # 真实页面里 + Code 可能只在悬停时出现、没有 aria-label、只响应 mousedown；可能是中文界面；可能根本没有按钮
    for query, tag, want in [
        ('&hover=1&kernel=local', '悬停才出现、只有 title、只响应 mousedown 的单元格 + Code', 'cell-toolbar+monaco-paste'),
        ('&zh=1&kernel=local', '中文界面的工具栏“代码”按钮', 'notebook-toolbar+monaco-paste'),
        ('&nobuttons=1&kernel=local', '没有任何 + Code 按钮时按 B', 'keyboard(B)+monaco-paste'),
    ]:
        page, fr, panel = ms_open(ctx, sw, query)
        wait_status_ok(panel)
        code, _, _ = ask(panel, '写一段代码')
        msg = last_bot(panel)
        r = click_and_wait_result(panel, msg, '.act-insert')
        cells = fr.evaluate(MS_CELLS_JS)
        new = [c for c in cells if c['focused']]
        check(f'[ms] {tag}：插在当前单元格下方并写入', len(cells) == 3 and new and new[0]['i'] == 2 and new[0]['code'].strip() == code.strip() and want in r, r)
        panel.close(); page.close()

    # 既插不了新单元格、又按 B 无效，但当前选中的是空单元格：直接写进去
    page, fr, panel = ms_open(ctx, sw, '&noinsert=1&kernel=local')
    wait_status_ok(panel)
    code, _, _ = ask(panel, '写一段代码')
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    cells = fr.evaluate(MS_CELLS_JS)
    outs = fr.evaluate("() => window.__fixtureOutputs")
    check('[ms] 插入新单元格失败时写进当前选中的空单元格并运行', len(cells) == 3 and cells[2]['code'].strip() == code.strip() and '已写入当前选中的空单元格' in r
          and outs and outs[-1]['index'] == 2 and outs[-1]['text'] == 'NBAC_OK 42 True', r)
    # 诊断信息：每个 frame 的结构、候选按钮；不含代码、输出和 Key
    panel.click('#plusBtn'); panel.click('#diagnose')
    panel.wait_for_function("() => /诊断信息/.test(document.getElementById('notice').textContent) && !/正在收集/.test(document.getElementById('notice').textContent)", timeout=15000)
    data = panel.evaluate("() => copyDiagnosticsForTest()")
    text = json.dumps(data, ensure_ascii=False)
    wb = [f for f in data['frames'] if '/notebook/main.html' in (f.get('url') or '')]
    check('[diag] 诊断信息包含所有 frame（外层页面、notebook-ide、extensionHost），标出适配器和关键选择器数量',
          len(data['frames']) >= 3 and wb and wb[0]['adapter'] == 'vscode-notebook' and wb[0]['counts']['.native-edit-context'] >= 3 and data['version'] == json.loads((HERE.parent / 'manifest.json').read_text())['version'], text[:300])
    check('[diag] ModelScope 列出候选动作按钮（tag/class/aria-label/title/文字）', wb and any(a.get('aria') == 'Add Markdown Cell' for a in wb[0].get('actions', [])) and len(wb[0].get('actions', [])) <= 60, json.dumps(wb[0].get('actions', [])[:3], ensure_ascii=False) if wb else '')
    check('[diag] 诊断信息不含代码、输出和 API Key', 'y = 1/0' not in text and 'NBAC_OK' not in text and 'print(' not in text and KEY not in text)
    check('[diag] 点按钮后提示已复制到剪贴板（或显示在框里手动复制）', '诊断信息已复制' in panel.inner_text('#notice') or panel.is_visible('#diagOutput'), panel.inner_text('#notice'))
    panel.close(); page.close()

    # 没打开 Notebook / 在“我的 Notebook”列表页
    page, fr, panel = ms_open(ctx, sw, '&empty=1')
    panel.wait_for_selector('#status.bad', timeout=15000)
    st = panel.inner_text('#status')
    check('[ms] Code Editor 里没打开 .ipynb 时提示新建/打开 Notebook', '.ipynb' in st, st)
    panel.close(); page.close()
    page = ctx.new_page(); page.goto(MS + '/my/mynotebook')
    panel = open_panel(ctx, sw, MS + '/my/*')
    panel.wait_for_selector('#status.bad', timeout=15000)
    st = panel.inner_text('#status')
    check('[ms] 在“我的 Notebook”列表页提示先启动实例并点「查看」', '查看' in st, st)
    panel.close(); page.close()

ANRUI_BASE = '/instances/rgapi-one-click-test-0001/'
ANRUI = 'http://jupyter.anruicloud.test:8903'

DSW_BASE = '/dsw-2367657/'
DSW = 'http://dsw-gateway-cn-hangzhou.data.aliyun.test:8904'

def test_dsw(ctx, sw):
    """ModelScope GPU 实例（阿里云 PAI-DSW）：https://dsw-gateway-cn-hangzhou.data.aliyun.com/dsw-xxxx/lab?appId=MAAS&...，
    顶层页面就是 JupyterLab。本地用真实 JupyterLab + 同样的 base_url，域名 *.data.aliyun.test 指向本机。"""
    print('\n=== ModelScope DSW（阿里云 PAI-DSW JupyterLab） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1100, 'height': 900})
    page.goto(DSW + DSW_BASE + 'lab/tree/test.ipynb?appId=MAAS&instanceId=dsw-test&site=cn&features=EnableSubDomainProxy')
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    time.sleep(3)
    cells = lambda: page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')
    cells()[0].click(); page.keyboard.press('Shift+Enter')
    page.wait_for_function("() => [...document.querySelectorAll('.jp-OutputArea-output')].some(e => e.innerText.includes('42'))", timeout=60000)
    cells()[1].click()
    n0 = lab_cell_count(page)
    panel = open_panel(ctx, sw, DSW + '/dsw-*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    panel.click('#plusBtn'); panel.click('#refresh')
    status = wait_status_ok(panel)
    check('[dsw] 识别为「ModelScope DSW」，顶层 JupyterLab', 'ModelScope DSW（jupyterlab' in status and '主页面' in status, status)
    hw = ''
    for _ in range(90):
        hw = panel.inner_text('#hw')
        if '已检测' in hw or '没成功' in hw: break
        time.sleep(1)
    check('[dsw] 连接后自动在内核里静默检测硬件：显示 CPU 核数和内存，不新建单元格', '核 CPU' in hw and 'GB 内存' in hw and '已检测' in hw and lab_cell_count(page) == n0, hw)
    check('[dsw] 页面上看不到检测代码的输出', not page.evaluate("() => document.body.innerText.includes('NBAC_HW')"))
    code, _, _ = ask(panel, '读一个 csv 并画图')
    L = last()
    sysp = L.get('system', '')
    check('[dsw] 系统提示带平台名、清华镜像，并要求按实际配置写代码', 'ModelScope DSW' in sysp and 'pypi.tuna.tsinghua.edu.cn' in sysp and '所有代码都要按上面这份实际配置来写' in sysp and '核' in sysp, sysp[-300:])
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[dsw] 确认后插入并运行，输出 NBAC_OK 42 True', wait_text(page, 'NBAC_OK 42 True') and lab_cell_count(page) == n0 + 1, r)
    panel.close(); page.close()

def test_anrui(ctx, sw):
    """安睿云自建 JupyterLab：https://jupyter.anruicloud.com/instances/<实例>/lab，顶层页面就是 JupyterLab（不是 iframe），
    没有暴露 window.jupyterapp。本地用真实 JupyterLab 4 + 同样的 base_url，域名 jupyter.anruicloud.test 指向本机。"""
    print('\n=== 安睿云 JupyterLab（/instances/<id>/lab，顶层页面） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1100, 'height': 900})
    # 1) /instances/<id>/lab：启动器（还没打开 Notebook）→ 提示打开 .ipynb
    page.goto(ANRUI + ANRUI_BASE + 'lab?reset')
    page.wait_for_selector('#jp-main-dock-panel .jp-Launcher', timeout=60000)
    panel = open_panel(ctx, sw, ANRUI + '/instances/*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    panel.wait_for_selector('#status.bad', timeout=15000)
    st = panel.inner_text('#status')
    check('[anrui] /instances/<id>/lab 启动器页面：提示打开或新建 Notebook', '安睿云 JupyterLab' in st and '.ipynb' in st, st)
    # 2) 打开 Notebook（/instances/<id>/lab/tree/test.ipynb），侧边栏自动重新检测
    page.goto(ANRUI + ANRUI_BASE + 'lab/tree/test.ipynb')
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    time.sleep(3)
    cells = lambda: page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')
    cells()[0].click(); page.keyboard.press('Shift+Enter')
    page.wait_for_function("() => [...document.querySelectorAll('.jp-OutputArea-output')].some(e => e.innerText.includes('42'))", timeout=60000)
    cells()[1].click(); page.keyboard.press('Shift+Enter')
    page.wait_for_function("() => document.body.innerText.includes('ZeroDivisionError')", timeout=30000)
    cells()[1].click()
    # 安睿云页面顶部显示 “AMD Radeon Cloud … GPU … VRAM …”（仿真实页面的顶栏）
    page.evaluate("""() => { const d = document.createElement('div'); d.id = 'anrui-topbar';
      d.style.cssText = 'position:fixed;top:0;right:0;z-index:9999;background:#222;color:#fff;font:12px sans-serif;padding:2px 8px';
      d.textContent = 'AMD Radeon Cloud  |  GPU 0%  |  VRAM 0.2/48 GB  |  RAM 3.1/64 GB'; document.body.appendChild(d); }""")
    panel.click('#plusBtn'); panel.click('#refresh')
    status = wait_status_ok(panel)
    hw = panel.inner_text('#hw')
    check('[anrui] 从页面顶栏认出 AMD 显卡，状态栏显示「硬件：AMD GPU（ROCm）」', hw.startswith('硬件：AMD GPU（ROCm）') and '48 GB' in hw and '页面提示' in hw, hw)
    check('[anrui] 识别为「安睿云 JupyterLab」，顶层页面，走 JupyterLab 模型', '安睿云 JupyterLab（jupyterlab，JupyterLab 模型，主页面）' in status, status)
    check('[anrui] 页面没有暴露 window.jupyterapp', page.evaluate("() => !window.jupyterapp && !window.jupyterlab"))
    code, _, _ = ask(panel, '读一个 csv 并画图')
    L = last()
    check('[anrui] 读到当前单元格代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''))
    check('[anrui] 系统提示带平台名和清华镜像（国内云）', 'pypi.tuna.tsinghua.edu.cn' in L.get('system', '') and '安睿云 JupyterLab' in L.get('system', ''), L.get('system', '')[:80])
    sysp = L.get('system', '')
    check('[anrui] 系统提示按 AMD ROCm 写：仍用 cuda 设备、rocm-smi、ROCm 轮子、不装 CUDA 专用包', all(x in sysp for x in ['AMD GPU', 'ROCm', '"cuda"', 'rocm-smi', 'download.pytorch.org/whl/rocm6.x', 'bitsandbytes', 'flash-attn', '不要重装']), sysp[-300:])
    msg = last_bot(panel)
    n0 = lab_cell_count(page)
    r = click_and_wait_result(panel, msg, '.act-insert')
    check('[anrui] 插入新单元格（直接写 JupyterLab 模型）', lab_cell_count(page) == n0 + 1 and (lab_active_cell_text(page) or '').strip() == code.strip() and 'jupyterlab-model' in r, r)
    msg.query_selector('.act-run').click()
    check('[anrui] 运行前要确认', msg.query_selector('.confirm').is_visible())
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[anrui] 确认后插入并运行，输出 NBAC_OK 42 True', wait_text(page, 'NBAC_OK 42 True'), r)
    cells()[1].click()
    code, _, _ = ask(panel, fix=True)
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    check('[anrui] 修复报错后运行成功（NBAC_FIXED 1.0）', 'NBAC_FIXED' in code and wait_text(page, 'NBAC_FIXED 1.0'), r)
    # 「+ → 检测硬件」：插入只读检测代码，确认后运行并读回结果（本机没有 torch / GPU → 仅 CPU）
    n_bots = bot_count(panel)
    panel.click('#plusBtn'); panel.click('#probeHw')
    panel.wait_for_function("(n) => document.querySelectorAll('.msg.bot:not(.pending)').length > n", arg=n_bots, timeout=5000)
    msg = last_bot(panel)
    probe = msg.query_selector('textarea').input_value()
    check('[anrui] 检测硬件：给出只读的检测代码（打印 NBAC_HW，不安装东西）', 'NBAC_HW' in probe and 'torch.version' in probe and 'pip install' not in probe)
    n0 = lab_cell_count(page)
    msg.query_selector('.act-run').click()
    check('[anrui] 检测硬件也要先确认才运行', msg.query_selector('.confirm').is_visible() and lab_cell_count(page) == n0)
    msg.query_selector('.act-confirm').click()
    ok = True
    try:
        panel.wait_for_function("(m) => /硬件：/.test(m.querySelector('.result').textContent)", arg=msg, timeout=60000)
    except Exception:
        ok = False
    res = msg.query_selector('.result').inner_text()
    hw = panel.inner_text('#hw')
    check('[anrui] 检测硬件：运行后自动读回结果并保存（本机没有 torch：显卡沿用页面的 AMD，CPU 核数和内存用检测结果）', ok and '核 CPU' in res and hw.startswith('硬件：AMD GPU（ROCm）') and '核 CPU' in hw and 'GB 内存' in hw, res + ' | ' + hw)
    panel.click('#plusBtn'); panel.click('#refresh')
    wait_status_ok(panel)
    hw = panel.inner_text('#hw')
    check('[anrui] 重新检测后仍用保存的检测结果（CPU 核数、内存）', 'AMD' in hw and '核 CPU' in hw and 'GB 内存' in hw, hw)
    ask(panel, '训练一个小模型')
    sysp = last().get('system', '')
    check('[anrui] 检测结果用到之后的提示词里（AMD + CPU 核数、内存）', 'AMD GPU' in sysp and 'num_workers 不超过 CPU 核数' in sysp, sysp[-200:])
    # 输出读不到的平台：用户把 NBAC_HW 那一行贴回来
    panel.fill('#prompt', 'NBAC_HW {"vendor":"amd","devices":[{"name":"AMD Radeon PRO W7900","vram_gb":48.0}],"torch":"2.5.1+rocm6.2","hip_build":"6.2"}')
    panel.click('#send')
    panel.wait_for_function("() => document.getElementById('hw').textContent.includes('W7900')", timeout=5000)
    hw = panel.inner_text('#hw')
    check('[anrui] 贴回 NBAC_HW 输出也能记录硬件（AMD W7900 · 已检测）', 'AMD GPU（ROCm）' in hw and 'W7900' in hw and '已检测' in hw, hw)
    ask(panel, '训练一个小模型')
    sysp = last().get('system', '')
    check('[anrui] 之后的提示词按 AMD W7900 写', 'AMD GPU（AMD Radeon PRO W7900' in sysp and 'rocm-smi' in sysp, sysp[-200:])
    page.screenshot(path=str(SHOT_DIR / 'anrui-notebook.png'))
    panel.close(); page.close()

def test_selfhosted(ctx, sw):
    """网站不在 manifest 的内容脚本匹配列表里（自建 JupyterLab）：侧边栏用 chrome.scripting 主动注入；
    没有主机权限时显示「在此网站启用助手」；授权后登记动态内容脚本，刷新网页自动加载。
    selfhosted.test 在测试版的 host_permissions 里（相当于用户已经点过授权），noperm.test 什么权限都没有。"""
    print('\n=== 自建 JupyterLab（侧边栏主动注入脚本 / 申请网站权限） ===', flush=True)
    base = 'http://selfhosted.test:8903' + ANRUI_BASE
    page = ctx.new_page()
    page.set_viewport_size({'width': 1100, 'height': 900})
    page.goto(base + 'lab/tree/test.ipynb')
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    time.sleep(2)
    check('[selfhosted] 网页上没有自动加载内容脚本（不在匹配列表里）', page.evaluate("() => !window.__nbacPageLoaded && !window.__nbacEarly"))
    page.query_selector_all('.jp-Notebook .jp-Cell .cm-content')[0].click()
    panel = open_panel(ctx, sw, 'http://selfhosted.test:8903/*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    check('[selfhosted] 侧边栏主动注入脚本后连上 JupyterLab', 'Jupyter（jupyterlab' in status and page.evaluate("() => !!window.__nbacPageLoaded && !!window.__nbacEarly"), status)
    check('[selfhosted] 提示“已经手动加载”', '手动加载' in panel.inner_text('#notice'), panel.inner_text('#notice'))
    check('[selfhosted] 没有显示权限按钮', not panel.is_visible('#siteAccess'))
    code, _, _ = ask(panel, '读一个 csv 并画图')
    msg = last_bot(panel)
    k = page.evaluate(OUT_COUNT_JS, 'NBAC_OK 42 True')
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    ok = True
    try:
        page.wait_for_function("([t, n]) => (" + OUT_COUNT_JS + ")(t) > n", arg=['NBAC_OK 42 True', k], timeout=30000)
    except Exception:
        ok = False
    check('[selfhosted] 注入后插入并运行成功', ok and '运行：' in r, r)
    # 授权后（测试里跳过 Chrome 的弹窗）登记动态内容脚本：刷新网页后自动加载
    panel.evaluate("() => window.enableSiteForTest(['http://selfhosted.test/*'])")
    reg = panel.evaluate("async () => (await chrome.scripting.getRegisteredContentScripts()).map(x => x.id + ':' + x.matches.join(','))")
    check('[selfhosted] 授权后登记了这个网站的内容脚本（early / page / bridge）', len([x for x in reg if 'selfhosted.test' in x]) == 3, reg)
    page.reload()
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    ok = True
    try:
        page.wait_for_function("() => !!window.__nbacPageLoaded && !!window.__nbacEarly && !!window.__nbacEarly.listenerObjects", timeout=10000)
    except Exception:
        ok = False
    check('[selfhosted] 刷新后脚本自动加载（document_start 的 early.js 也在）', ok)
    panel.evaluate("() => { document.getElementById('notice').textContent = ''; }")
    panel.click('#plusBtn'); panel.click('#refresh')
    status = wait_status_ok(panel)
    check('[selfhosted] 刷新后直接连上（不用再注入），走 JupyterLab 模型', 'JupyterLab 模型' in status and '手动加载' not in panel.inner_text('#notice'), status)
    panel.close()
    # 没有权限的网站：显示「在此网站启用助手」按钮
    page.goto('http://noperm.test:8903' + ANRUI_BASE + 'lab/tree/test.ipynb')
    page.wait_for_selector('.jp-Notebook .jp-Cell .cm-content', timeout=60000)
    panel = open_panel(ctx, sw, 'http://noperm.test:8903/*')
    panel.wait_for_selector('#siteAccess:not([hidden])', timeout=15000)
    st = panel.inner_text('#status')
    check('[noperm] 没有权限：状态说明需要权限，并显示「在此网站启用助手」', '权限' in st and panel.inner_text('#enableSite') == '在此网站启用助手' and 'http://noperm.test' in panel.inner_text('#siteHint'), st + ' | ' + panel.inner_text('#siteHint'))
    check('[noperm] 状态不再误报“不是 Notebook 页面”', '不是 Notebook 页面' not in st, st)
    data = panel.evaluate("() => window.copyDiagnosticsForTest()")
    inj = data.get('inject') or {}
    check('[noperm] 诊断信息里有注入失败原因和权限信息', inj.get('ok') is False and 'Cannot access' in (inj.get('error') or '') and 'permissions' in data, json.dumps(inj, ensure_ascii=False)[:200])
    panel.close(); page.close()

def test_options(ctx, sw):
    print('\n=== 设置页 ===', flush=True)
    ext_id = sw.url.split('/')[2]
    p = ctx.new_page()
    p.goto(f'chrome-extension://{ext_id}/src/options/options.html')
    p.evaluate("() => chrome.storage.local.clear()")
    p.reload()
    p.wait_for_selector('input[data-p="bailian"]')
    check('[options] 默认服务商是阿里云百炼', p.input_value('#active') == 'bailian')
    check('[options] 百炼默认地址/模型', p.input_value('input[data-p="bailian"][data-f="baseUrl"]') == 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          and p.input_value('input[data-p="bailian"][data-f="model"]') == 'deepseek-v4.1-flash')
    check('[options] DeepSeek 官方默认 https://api.deepseek.com + deepseek-flash', p.input_value('input[data-p="deepseek"][data-f="baseUrl"]') == 'https://api.deepseek.com'
          and p.input_value('input[data-p="deepseek"][data-f="model"]') == 'deepseek-flash')
    check('[options] Gemini 默认 gemini-3.5-flash', p.input_value('input[data-p="gemini"][data-f="model"]') == 'gemini-3.5-flash')
    p.fill('input[data-p="bailian"][data-f="apiKey"]', 'sk-dummy-bailian')
    p.fill('input[data-p="deepseek"][data-f="apiKey"]', 'sk-dummy-deepseek')
    p.click('#save')
    p.wait_for_function("() => document.getElementById('message').textContent.includes('已保存')")
    local = p.evaluate("() => chrome.storage.local.get(null)")
    sync = p.evaluate("() => chrome.storage.sync.get(null)")
    check('[options] 多个服务商的 Key 分别存在 storage.local', local['providers']['bailian']['apiKey'] == 'sk-dummy-bailian' and local['providers']['deepseek']['apiKey'] == 'sk-dummy-deepseek')
    check('[options] storage.sync 为空（不同步 Key）', sync == {})
    p.click('#clearKeys')
    p.wait_for_function("() => document.getElementById('message').textContent.includes('已清除')")
    local = p.evaluate("() => chrome.storage.local.get(null)")
    check('[options] 清除所有 Key', all(v['apiKey'] == '' for v in local['providers'].values()))
    p.screenshot(path=str(SHOT_DIR / 'options.png'), full_page=True)
    p.close()

def screenshot_demo(ctx, sw):
    """说明用截图：Notebook + 侧边栏（同一个面板页面，以弹窗形式打开）。"""
    print('\n=== 截图 ===', flush=True)
    page = prepare_lab_page(ctx, 8900)
    panel = open_panel(ctx, sw, 'http://127.0.0.1:8900/*', size=(420, 900))
    panel.set_viewport_size({'width': 420, 'height': 900})
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='high', includeContext=True)
    wait_status_ok(panel)
    panel.screenshot(path=str(SHOT_DIR / 'panel-welcome.png'))
    ask(panel, '配置好训练 YOLO11m 的环境并写好训练代码')
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    click_and_wait_result(panel, msg, '.act-confirm')
    check('[demo] 截图用的运行也成功', wait_text(page, 'NBAC_OK 42 True'))
    time.sleep(1)
    page.screenshot(path=str(SHOT_DIR / 'demo-notebook.png'))
    panel.screenshot(path=str(SHOT_DIR / 'demo-panel.png'))
    panel.close(); page.close()

def main():
    ext = subprocess.check_output([PY, str(HERE / 'build_test_ext.py')], text=True).strip()
    mock = subprocess.Popen([PY, str(HERE / 'mock_server.py'), str(MOCK_PORT)])
    labs = [start_lab(8899, False), start_lab(8900, True), start_lab(8901, False, frameable=True),
            start_lab(8902, False, base_url='/bj-cpu-01/user/123/456/', zh=True)]
    labs.append(subprocess.Popen([PY, str(HERE / 'aistudio_proxy.py'), '8770', '8902']))
    labs.append(subprocess.Popen([PY, str(HERE / 'modelscope_server.py'), '8771']))
    labs.append(start_lab(8903, False, base_url=ANRUI_BASE, remote=True))
    labs.append(start_lab(8904, False, base_url=DSW_BASE, remote=True))
    try:
        wait_http(MOCK + '/last')
        wait_http('http://127.0.0.1:8770/bj-cpu-01/user/123/456/home')
        wait_http('http://127.0.0.1:8771/my/mynotebook')
        with sync_playwright() as pw:
            udd = tempfile.mkdtemp(prefix='nbac-chrome-')
            ctx = pw.chromium.launch_persistent_context(udd, headless=False, args=[
                f'--disable-extensions-except={ext}', f'--load-extension={ext}',
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows', '--window-size=1100,1000', '--window-position=0,0',
                '--host-resolver-rules=MAP *.kaggle.test 127.0.0.1, MAP *.kagglenet.test 127.0.0.1, MAP aistudio.baidu.test 127.0.0.1, MAP modelscope.test 127.0.0.1, MAP g.alicdn.test 127.0.0.1, MAP *.anruicloud.test 127.0.0.1, MAP *.data.aliyun.test 127.0.0.1, MAP selfhosted.test 127.0.0.1, MAP noperm.test 127.0.0.1'])
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            for t in (test_options, test_models_and_thinking,
                      lambda c, s: test_jupyterlab(c, s, 8899, 'dom'),
                      lambda c, s: test_jupyterlab(c, s, 8900, 'app'),
                      test_kaggle, test_aistudio, test_aistudio_monaco, test_aistudio_outer, test_modelscope, test_modelscope_autoprobe, test_dsw, test_anrui, test_selfhosted, screenshot_demo):
                only = os.environ.get('NBAC_ONLY')
                if only and getattr(t, '__name__', '') != only: continue
                try:
                    t(ctx, sw)
                except Exception as e:
                    check('测试步骤异常: ' + getattr(t, '__name__', 'lambda'), False, repr(e)[:300])
            ctx.close()
    finally:
        mock.terminate()
        for l in labs:
            l.terminate()
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed')
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
