"""仿 ModelScope 免费 CPU 实例的 Code Editor（VS Code web）结构，给 e2e 测试用。

结构照抄 2026-11 真实抓取（/workspace/modelscope-snapshot）：
  http://modelscope.test:<port>/code/workspace?instanceId=...   外层页面（React/antd 外壳），同源嵌
    iframe[title="notebook-ide"] → /notebook/main.html           VS Code 工作台 + 原生 Notebook 编辑器（modelscope_workbench.html）
      iframe → /notebook/extensionHostIframe.html                同源，诱饵（不是 Notebook）
      iframe.webview → http://g.alicdn.test:<port>/webviews/...   跨域 webview（输出渲染器）；扩展不会注入
  /vs/...                                                         monaco-editor 静态文件（tests/node_modules）
用法：python modelscope_server.py <port>
"""
import sys
from pathlib import Path
from aiohttp import web

HERE = Path(__file__).resolve().parent
VS_DIR = HERE / 'node_modules' / 'monaco-editor' / 'min' / 'vs'

TOP = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Code Workspace · ModelScope</title>
<style>body{margin:0}.ms-page-codeWorkspace{display:flex;flex-direction:column;height:100vh}.hdr{height:36px;border-bottom:1px solid #ddd;font:13px sans-serif;padding:8px}
iframe.ide{flex:1;border:0;width:100%}</style></head>
<body><div id="root"><div class="antd5-app"><div class="antd5-layout ms-page-codeWorkspace">
<div class="hdr">ModelScope | Code Editor · Instance spec: DSW-CPU · <button>Running</button> <button>Share Work</button></div>
<iframe src="/notebook/main.html?t=1794466056581&lang=en-US{{extra}}" title="notebook-ide" class="ide" frameborder="0"></iframe>
</div></div></div>
<iframe src="http://g.alicdn.test:{{port}}/platform/xdomain-storage/frame.html" style="display:none"></iframe>
</body></html>"""

EXT_HOST = """<!doctype html><html><body><div class="monaco-editor"><div class="view-lines"><div class="view-line">decoy</div></div></div></body></html>"""
WEBVIEW = """<!doctype html><html><body><div class="output">webview</div></body></html>"""
MYNB = """<!doctype html><html lang="zh-CN"><body><h1>我的 Notebook</h1><button>启动</button></body></html>"""


async def handle(request):
    path = request.path
    port = str(request.app['port'])
    host = request.host.split(':')[0]
    if host.startswith('g.alicdn'):
        return web.Response(text=WEBVIEW, content_type='text/html')
    if path == '/code/workspace':
        extra = ''.join('&%s=%s' % (k, v) for k, v in request.query.items() if k in ('readable', 'nopaste', 'nowrite', 'kernel', 'empty', 'hover', 'zh', 'nobuttons', 'noinsert'))
        return web.Response(text=TOP.replace('{{extra}}', extra).replace('{{port}}', port), content_type='text/html')
    if path == '/notebook/main.html':
        return web.Response(text=(HERE / 'modelscope_workbench.html').read_text().replace('{{port}}', port), content_type='text/html')
    if path == '/notebook/extensionHostIframe.html':
        return web.Response(text=EXT_HOST, content_type='text/html')
    if path.startswith('/my/mynotebook'):
        return web.Response(text=MYNB, content_type='text/html')
    if path.startswith('/vs/'):
        f = (VS_DIR / path[len('/vs/'):]).resolve()
        if VS_DIR in f.parents and f.is_file():
            return web.FileResponse(f)
    return web.Response(status=404, text='not found')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8771
    app = web.Application()
    app['port'] = port
    app.router.add_route('*', '/{tail:.*}', handle)
    web.run_app(app, host='127.0.0.1', port=port, print=None)


if __name__ == '__main__':
    main()
