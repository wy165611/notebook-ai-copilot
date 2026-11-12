"""仿飞桨 AI Studio BML Codelab（结构依据 2026-11 在真实 AI Studio 上抓取的 DOM，见 tests/README.md）：
  /bj-cpu-01/user/123/456/home          宿主页面：#vscode-frame（诱饵，内含嵌套 iframe）+ #jupyterlab-frame
  /bj-cpu-01/user/123/456/vscode/       诱饵：仿 VS Code，内含 Monaco 编辑器样式的元素和嵌套 webview iframe
  /bj-cpu-01/user/123/456/lab...        反向代理到本机真实 JupyterLab（同源，含 WebSocket）
  /bj-cpu-01/user/123/789/home          宿主页面，iframe 里是 Monaco 单元格夹具（AI Studio 实际用 Monaco 而不是 CodeMirror）
  /bj-cpu-01/user/123/789/lab           Monaco 单元格夹具（aistudio_monaco_fixture.html）
  /project/edit/10871106                仿外层项目编辑器（不是 JupyterLab）
  /vs/...                               monaco-editor 的静态文件（tests/node_modules）
用法：python aistudio_proxy.py <监听端口> <JupyterLab 端口>"""
import sys, pathlib, asyncio
import aiohttp
from aiohttp import web

HERE = pathlib.Path(__file__).resolve().parent
BASE = '/bj-cpu-01/user/123/456/'
MON = '/bj-cpu-01/user/123/789/'
VS_DIR = HERE / 'node_modules' / 'monaco-editor' / 'min' / 'vs'

HOST_PAGE = """<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>BML Codelab</title>
<style>body{margin:0}.codelab-mainframe{border:0;width:100%;height:100vh;display:block}
.codelab-switcher{position:fixed;right:20px;top:60px;z-index:9;background:#fff;border:1px solid #ddd;border-radius:6px;padding:4px 8px;font:12px sans-serif}
#vscode-frame{display:none}</style></head><body>
<div id="codelab-switcher" class="codelab-switcher vscode">
  <div class="vscode switcher-btn light"><span class="switcher-btn-txt">切换至VS Code</span></div>
  <div class="codelab switcher-btn light"><span class="switcher-btn-txt">切换至JupyterLab</span></div>
</div>
<iframe id="vscode-frame" class="codelab-mainframe vscode-frame" title="vscode-frame" src="{{base}}vscode/"></iframe>
<iframe id="jupyterlab-frame" class="codelab-mainframe jupyterlab-frame" title="jupyterlab-frame" src="{{lab}}"></iframe>
</body></html>"""

VSCODE_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>VS Code</title></head><body>
<div class="monaco-workbench"><div class="monaco-editor"><div class="view-lines"><div class="view-line">print('vscode decoy')</div></div><textarea class="inputarea"></textarea></div></div>
<iframe class="webview" src="{{base}}vscode/webview.html"></iframe><iframe class="webview" src="about:blank"></iframe>
</body></html>"""
WEBVIEW_PAGE = """<!doctype html><html><body><iframe src="about:blank"></iframe><div class="monaco-editor"></div></body></html>"""

OUTER_EDITOR = """<!doctype html><html><head><meta charset="utf-8"><title>nbac-test - 飞桨AI Studio</title></head><body>
<div class="project-header">我的项目 · nbac-test <button>专业开发</button> <button>公开项目</button></div>
<div class="notebook-cells"><div class="cell"><div class="line-numbers">1</div><pre class="code">x = 41</pre></div></div>
<div class="bottom-toolbar"><button>正文</button><button>代码</button><button>运行全部</button><button>中断</button><button>重启</button></div>
</body></html>"""

def fill(t, d):
    for k, v in d.items():
        t = t.replace('{{%s}}' % k, v)
    return t


async def handle(request):
    path = request.path
    if path == BASE + 'home':
        return web.Response(text=fill(HOST_PAGE, {'base': BASE, 'lab': BASE + 'lab/tree/test.ipynb'}), content_type='text/html')
    if path == MON + 'home':
        return web.Response(text=fill(HOST_PAGE, {'base': MON, 'lab': MON + 'lab'}), content_type='text/html')
    if path == MON + 'lab':
        return web.FileResponse(HERE / 'aistudio_monaco_fixture.html')
    if path in (BASE + 'vscode/', MON + 'vscode/'):
        return web.Response(text=fill(VSCODE_PAGE, {'base': path[:-len('vscode/')]}), content_type='text/html')
    if path.endswith('vscode/webview.html'):
        return web.Response(text=WEBVIEW_PAGE, content_type='text/html')
    if path.startswith('/project/edit/'):
        return web.Response(text=OUTER_EDITOR, content_type='text/html')
    if path.startswith('/vs/'):
        f = (VS_DIR / path[len('/vs/'):]).resolve()
        if VS_DIR.resolve() in f.parents and f.is_file():
            return web.FileResponse(f)
        return web.Response(status=404)
    if path.startswith(BASE):
        return await proxy(request)
    return web.Response(status=404, text='not found')

async def proxy(request):
    target = f'http://127.0.0.1:{LAB_PORT}{request.path_qs}'
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ('host',)}
    headers['Host'] = f'127.0.0.1:{LAB_PORT}'
    if 'Origin' in headers:  # 真实 AI Studio 是同一个网关，这里把 Origin 改成后端自己的，避免 Jupyter 拒绝跨源 WebSocket
        headers['Origin'] = f'http://127.0.0.1:{LAB_PORT}'
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        ws_server = web.WebSocketResponse(protocols=[p.strip() for p in request.headers.get('Sec-WebSocket-Protocol', '').split(',') if p.strip()])
        await ws_server.prepare(request)
        async with aiohttp.ClientSession() as s:
            hdr = {k: v for k, v in headers.items() if k.lower() not in ('upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol')}
            async with s.ws_connect(target.replace('http://', 'ws://'), headers=hdr, protocols=ws_server.ws_protocol and [ws_server.ws_protocol] or (), max_msg_size=0) as ws_client:
                async def a2b():
                    async for m in ws_server:
                        if m.type == aiohttp.WSMsgType.TEXT: await ws_client.send_str(m.data)
                        elif m.type == aiohttp.WSMsgType.BINARY: await ws_client.send_bytes(m.data)
                        else: break
                async def b2a():
                    async for m in ws_client:
                        if m.type == aiohttp.WSMsgType.TEXT: await ws_server.send_str(m.data)
                        elif m.type == aiohttp.WSMsgType.BINARY: await ws_server.send_bytes(m.data)
                        else: break
                await asyncio.wait([asyncio.ensure_future(a2b()), asyncio.ensure_future(b2a())], return_when=asyncio.FIRST_COMPLETED)
        return ws_server
    body = await request.read()
    async with aiohttp.ClientSession(auto_decompress=False) as s:
        async with s.request(request.method, target, headers=headers, data=body, allow_redirects=False) as r:
            data = await r.read()
            out = {k: v for k, v in r.headers.items() if k.lower() not in ('transfer-encoding', 'connection', 'content-length')}
            return web.Response(status=r.status, body=data, headers=out)

if __name__ == '__main__':
    PORT, LAB_PORT = int(sys.argv[1]), int(sys.argv[2])
    app = web.Application(client_max_size=1024 ** 3)
    app.router.add_route('*', '/{tail:.*}', handle)
    web.run_app(app, host='127.0.0.1', port=PORT, print=None)
