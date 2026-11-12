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

def start_lab(port, expose, frameable=False, base_url=None, zh=False):
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
    panel.wait_for_function("(m) => /已插入|失败/.test(m.querySelector('.result').textContent)", arg=msg, timeout=20000)
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
    want = ('（jupyterlab，JupyterLab API，主页面）' in status) if mode == 'app' else ('（jupyterlab，主页面）' in status)
    check(f'[{mode}] 检测到 Notebook', want, status)

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
    """平台把工具栏藏起来 / 干脆没有这些按钮时的兜底路径。"""
    # a) 工具栏被 CSS 隐藏：隐藏的按钮仍然可用
    target.add_style_tag(content='.jp-Toolbar { display: none !important; }')
    n = target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js)
    k = target.evaluate("() => document.body.innerText.split('NBAC_FIXED 1.0').length")
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
    k = target.evaluate("() => document.body.innerText.split('NBAC_FIXED 1.0').length")
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    ok = True
    try:
        target.wait_for_function(done_js, arg=k, timeout=30000)
    except Exception:
        ok = False
    check(f'[{tag}] 没有任何按钮时用快捷键/底部添加区插入并用 Shift+Enter 运行', ('keyboard' in r or 'notebook-footer' in r) and target.eval_on_selector_all('.jp-Notebook .jp-Cell', count_js) >= n + 1 and ok, r)

COUNT_JS = 'e => e.length'
FIXED_N_JS = "(n) => document.body.innerText.split('NBAC_FIXED 1.0').length > n"

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
    r = click_and_wait_result(panel, msg, '.act-insert')
    txt = fr.evaluate("() => { const c = document.querySelector('.jp-Notebook .jp-Cell.jp-mod-active .cm-content'); return c ? c.cmView.view.state.doc.toString() : ''; }")
    check('[aistudio] 插入新单元格并写入代码', fr.eval_on_selector_all('.jp-Notebook .jp-Cell', COUNT_JS) == n0 + 1 and txt.strip() == code.strip(), r)
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

def test_aistudio_monaco(ctx, sw):
    """AI Studio 的单元格编辑器实际是 Monaco：用照抄真实 DOM 的夹具 + 真实 monaco-editor（不暴露 window.monaco）测读写。运行是假的。"""
    print('\n=== 飞桨 AI Studio Monaco 单元格（真实 DOM 结构夹具，运行为假） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(AIS + '/bj-cpu-01/user/123/789/home#codelab')
    fr = wait_frame(page, lambda f: f.url.endswith('/789/lab') and f.evaluate('() => !!window.__fixtureReady'), 'monaco fixture', 30)
    check('[monaco] 夹具里没有全局 window.monaco', fr.evaluate("() => !window.monaco"))
    panel = open_panel(ctx, sw, AIS + '/bj-cpu-01/user/123/789/*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    check('[monaco] 检测到 Notebook', '飞桨 AI Studio' in status and 'jupyterlab' in status, status)
    code, _, _ = ask(panel, fix=True)
    L = last()
    check('[monaco] 从 Monaco 单元格读到代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''), L.get('user', '')[:120])
    msg = last_bot(panel)
    n0 = fr.eval_on_selector_all('.jp-Cell', COUNT_JS)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    val = fr.evaluate("() => { const c = document.querySelector('.jp-Cell.jp-mod-active'); return c ? window.__fixtureMonaco.editor.getEditors().find(e => c.contains(e.getDomNode())).getValue() : ''; }")
    check('[monaco] 用中文标题的单元格工具栏按钮插入，并通过粘贴写入 Monaco（内容完全一致，没有多出括号）', fr.eval_on_selector_all('.jp-Cell', COUNT_JS) == n0 + 1 and val.strip() == code.strip() and 'monaco-paste' in r, r + ' | ' + val[:80])
    check('[monaco] Shift+Enter 运行（夹具的假运行）', wait_text(fr, 'NBAC_FIXED 1.0', 10000))
    page.screenshot(path=str(SHOT_DIR / 'aistudio-monaco.png'))
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
    try:
        wait_http(MOCK + '/last')
        wait_http('http://127.0.0.1:8770/bj-cpu-01/user/123/456/home')
        with sync_playwright() as pw:
            udd = tempfile.mkdtemp(prefix='nbac-chrome-')
            ctx = pw.chromium.launch_persistent_context(udd, headless=False, args=[
                f'--disable-extensions-except={ext}', f'--load-extension={ext}',
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows', '--window-size=1100,1000', '--window-position=0,0',
                '--host-resolver-rules=MAP *.kaggle.test 127.0.0.1, MAP *.kagglenet.test 127.0.0.1, MAP aistudio.baidu.test 127.0.0.1'])
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            for t in (test_options, test_models_and_thinking,
                      lambda c, s: test_jupyterlab(c, s, 8899, 'dom'),
                      lambda c, s: test_jupyterlab(c, s, 8900, 'app'),
                      test_kaggle, test_aistudio, test_aistudio_monaco, test_aistudio_outer, screenshot_demo):
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
