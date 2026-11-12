"""本地模拟模型服务（不需要真实 API Key）。
OpenAI 兼容（百炼 compatible-mode 路径 /compatible-mode/v1，DeepSeek 路径 /deepseek）：
  GET  .../models            模型列表（含语音/向量模型，用来测试过滤）
  POST .../chat/completions  对话；带 “/” 的模型 → 400 未开通；old-model-403 → 403；
                             no-think-model 收到思考参数 → 400（测试去参重试）
Gemini：GET /v1beta/models、POST /v1beta/models/<m>:generateContent
GET /last  最近一次对话请求（含完整请求体）；GET /log 所有对话请求
GET /code/...  仿 www.kaggle.com 编辑器顶层页面（kaggle_top.html），iframe 里嵌本机 JupyterLab
用户消息含“请修复下面这个单元格的报错”→ 返回修复后的代码，否则返回固定示例代码；
系统提示是终端模式 → 返回 ```bash 命令；聊天模式 → 返回带 HTML 字符、超过 600 字、带代码块的纯文字回答。"""
import json, sys, pathlib
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = pathlib.Path(__file__).resolve().parent
KEY = 'test-key-not-secret'
LAST, LOG = {}, []

GEN_CODE = 'import platform\nprint("NBAC_OK", 6 * 7, platform.python_version() != "")\n'
FIX_CODE = 'x = 1 / 1  # 除数改成非 0\nprint("NBAC_FIXED", x)\n'
OPENAI_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'qwen3.8-max', 'kimi-k3', 'glm-5.3',
                 'MiniMax/MiniMax-M3', 'old-model-403', 'no-think-model', 'text-only-model',
                 'paraformer-v2', 'qwen-tts-latest', 'text-embedding-v4', 'wanx2.1-t2i-turbo']
GEMINI_MODELS = [('gemini-3.5-flash', ['generateContent']), ('gemini-3.6-flash', ['generateContent']),
                 ('gemini-3.8-flash', ['generateContent']), ('gemini-embedding-001', ['embedContent']),
                 ('imagen-4.0-generate-001', ['predict'])]
THINK_KEYS = ('enable_thinking', 'thinking_budget', 'reasoning_effort', 'thinking')

BASH_CODE = '# 测试用命令\necho "NBAC_BASH $((6 * 7))"\n'
CHAT_TEXT = ('这是聊天模式的解答：<b>NBAC_CHAT_ANSWER</b> 不应该被当成 HTML。\n\n'
             + '第二段说明，用 `pip` 安装即可。' + '很长的解释。' * 130 + 'NBAC_CHAT_END\n\n'
             + '```python\nprint("NBAC_CHAT_CODE")\n```\n最后一句。')

BOOM_CODE = 'print("NBAC_BEFORE_BOOM")\nraise ValueError("NBAC_BOOM")\n'
BASH_ERR = 'echo "NBAC_BASH_OUT"\necho "NBAC_BASH_ERR" >&2\nexit 3\n'
NEXT_CODE = 'print("NBAC_NEXT", 2 * 21)\n'

def answer(user_text, system=''):
    # 终端模式 / 聊天模式按系统提示区分；其他情况和以前一样返回 Python 单元格
    if '终端（bash）助手' in system:
        return '下面是命令：\n```bash\n' + (BASH_ERR if '会报错的命令' in user_text else BASH_CODE) + '```'
    if '问答助手' in system:
        return CHAT_TEXT
    if '写一段会报错的代码' in user_text:
        code = BOOM_CODE
    elif '请修复下面这个单元格的报错' in user_text:
        code = FIX_CODE
    elif '请根据输出判断这一步有没有成功' in user_text:
        code = NEXT_CODE
    else:
        code = GEN_CODE
    return '下面是代码：\n```python\n' + code + '```'

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def send(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.cors()
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def bearer_ok(self):
        return self.headers.get('Authorization') == 'Bearer ' + KEY

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/last':
            return self.send(200, LAST)
        if path == '/log':
            return self.send(200, LOG)
        if path == '/reset':
            LOG.clear(); LAST.clear(); return self.send(200, {})
        if path.startswith('/code/'):
            return self.send(200, (HERE / 'kaggle_top.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/blank.html':
            return self.send(200, b'<!doctype html><title>blank</title><p>blank', 'text/html; charset=utf-8')
        if path in ('/compatible-mode/v1/models', '/deepseek/models'):
            if not self.bearer_ok():
                return self.send(401, {'error': {'message': 'Incorrect API key'}})
            ids = OPENAI_MODELS if path.startswith('/compatible') else ['deepseek-flash', 'deepseek-v4-pro']
            return self.send(200, {'object': 'list', 'data': [{'id': i, 'object': 'model'} for i in ids]})
        if path == '/v1beta/models':
            if self.headers.get('x-goog-api-key') != KEY:
                return self.send(400, {'error': {'message': 'API key not valid'}})
            return self.send(200, {'models': [{'name': 'models/' + n, 'supportedGenerationMethods': m} for n, m in GEMINI_MODELS]})
        self.send(404, {'error': {'message': 'not found'}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if ':generateContent' in self.path:
            if self.headers.get('x-goog-api-key') != KEY:
                return self.send(400, {'error': {'message': 'API key not valid'}})
            parts = [p for c in body.get('contents', [])[-1:] for p in c.get('parts', [])]
            user = ''.join(p.get('text', '') for p in parts)
            rec = {'format': 'gemini', 'path': self.path, 'user': user, 'body': body, 'images': sum(1 for p in parts if 'inlineData' in p or 'inline_data' in p),
                   'system': body.get('systemInstruction', {}).get('parts', [{}])[0].get('text', '')}
            LAST.clear(); LAST.update(rec); LOG.append(rec)
            return self.send(200, {'candidates': [{'content': {'role': 'model', 'parts': [
                {'text': '思考中…', 'thought': True}, {'text': answer(user, rec['system'])}]}}]})
        if self.path.endswith('/chat/completions'):
            if not self.bearer_ok():
                return self.send(401, {'error': {'message': 'Incorrect API key'}})
            msgs = body.get('messages', [])
            content = msgs[-1]['content'] if msgs else ''
            images = 0
            if isinstance(content, list):  # 多模态：[{type: text}, {type: image_url}]
                images = sum(1 for p in content if p.get('type') == 'image_url')
                user = ''.join(p.get('text', '') for p in content if p.get('type') == 'text')
            else:
                user = content
            model = body.get('model', '')
            rec = {'format': 'openai', 'path': self.path, 'model': model, 'user': user, 'body': body, 'images': images,
                   'system': next((m['content'] for m in msgs if m['role'] == 'system'), '')}
            LAST.clear(); LAST.update(rec); LOG.append(rec)
            if '/' in model:
                return self.send(400, {'error': {'code': 'Model.AccessDenied', 'message': 'Model not activated: please activate the model in the console first'}})
            if model == 'text-only-model' and images:
                return self.send(400, {'error': {'code': 'InvalidParameter', 'message': 'The model does not support image input: image_url is only supported by multimodal models'}})
            if model == 'old-model-403':
                return self.send(403, {'error': {'message': 'Access denied'}})
            if model == 'no-think-model' and any(k in body for k in THINK_KEYS):
                return self.send(400, {'error': {'message': "Unrecognized request argument supplied: enable_thinking"}})
            return self.send(200, {'choices': [{'message': {'role': 'assistant', 'content': answer(user, rec['system'])}}]})
        self.send(404, {'error': {'message': 'not found'}})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
