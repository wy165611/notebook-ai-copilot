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

def start_lab(port, expose):
    root = pathlib.Path(tempfile.mkdtemp(prefix=f'nbac-lab-{port}-'))
    make_notebook(root)
    args = [PY, '-m', 'jupyterlab', '--no-browser', f'--port={port}', '--ip=127.0.0.1',
            "--ServerApp.token=", "--ServerApp.password=", '--ServerApp.disable_check_xsrf=True',
            f'--ServerApp.root_dir={root}', '--LabApp.news_url=', '--LabApp.check_for_updates_class=jupyterlab.NeverCheckForUpdate']
    if expose:
        args.append('--LabApp.expose_app_in_browser=True')
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_http(f'http://127.0.0.1:{port}/api/status')
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
    want_kind = '（jupyterlab，JupyterLab API）' if mode == 'app' else '（jupyterlab）'
    check(f'[{mode}] 检测到 Notebook', want_kind in status, status)

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
        # 4b) 平台把工具栏改掉/藏起来时，退回到键盘快捷键（Esc→B 插入，Shift+Enter 运行）
        page.add_style_tag(content='.jp-Toolbar { display: none !important; }')
        n2 = lab_cell_count(page)
        msg.query_selector('.act-run').click()
        r = click_and_wait_result(panel, msg, '.act-confirm')
        ok = True
        try:
            page.wait_for_function("() => document.body.innerText.split('NBAC_FIXED 1.0').length > 2", timeout=30000)
        except Exception:
            ok = False
        check('[dom] 没有工具栏时用键盘快捷键插入并运行', 'keyboard' in r and lab_cell_count(page) >= n2 + 1 and ok, r)
    panel.close(); page.close()

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
    page.goto(MOCK + '/kaggle-fixture.html')
    panel = open_panel(ctx, sw, MOCK + '/kaggle-fixture.html*')
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

def test_kaggle_fixture(ctx, sw):
    print('\n=== Kaggle 近似夹具（APPROXIMATE） ===', flush=True)
    page = ctx.new_page()
    page.set_viewport_size({'width': 1000, 'height': 900})
    page.goto(MOCK + '/kaggle-fixture.html')
    page.wait_for_selector('.cm-content')
    page.query_selector_all('.cm-content')[1].click()
    panel = open_panel(ctx, sw, MOCK + '/kaggle-fixture.html*')
    set_storage(panel, providers=mock_providers(), active='bailian', thinking='default', includeContext=True)
    status = wait_status_ok(panel)
    check('[kaggle] 检测到 Kaggle 适配器', 'Kaggle' in status and 'kaggle-dom' in status, status)
    page.query_selector_all('.cm-content')[1].click()
    ask(panel, fix=True)
    L = last()
    check('[kaggle] 读取单元格代码和报错', 'y = 1/0' in L.get('user', '') and 'ZeroDivisionError' in L.get('user', ''))
    n0 = page.eval_on_selector_all('.cm-content', 'e => e.length')
    msg = last_bot(panel)
    msg.query_selector('.act-run').click()
    r = click_and_wait_result(panel, msg, '.act-confirm')
    ok = True
    try:
        page.wait_for_function("() => [...document.querySelectorAll('.output')].some(o => o.innerText.includes('NBAC_FIXED'))", timeout=15000)
    except Exception:
        ok = False
    n1 = page.eval_on_selector_all('.cm-content', 'e => e.length')
    new_text = page.eval_on_selector_all('.cm-content', 'e => e[e.length-1].innerText')
    check('[kaggle] “+ Code” 插入新单元格并写入代码', n1 == n0 + 1 and 'NBAC_FIXED' in new_text, r)
    check('[kaggle] 运行新单元格（夹具里的假运行）', ok)
    page.screenshot(path=str(SHOT_DIR / 'kaggle-fixture.png'))
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
    labs = [start_lab(8899, False), start_lab(8900, True)]
    try:
        wait_http(MOCK + '/last')
        with sync_playwright() as pw:
            udd = tempfile.mkdtemp(prefix='nbac-chrome-')
            ctx = pw.chromium.launch_persistent_context(udd, headless=False, args=[
                f'--disable-extensions-except={ext}', f'--load-extension={ext}',
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows', '--window-size=1100,1000', '--window-position=0,0'])
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            for t in (test_options, test_models_and_thinking,
                      lambda c, s: test_jupyterlab(c, s, 8899, 'dom'),
                      lambda c, s: test_jupyterlab(c, s, 8900, 'app'),
                      test_kaggle_fixture, screenshot_demo):
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
