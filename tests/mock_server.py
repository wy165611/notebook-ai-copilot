"""本地模拟模型服务（不需要真实 API Key）。
OpenAI 兼容（百炼 compatible-mode 路径 /compatible-mode/v1，DeepSeek 路径 /deepseek）：
  GET  .../models            模型列表（含语音/向量模型，用来测试过滤）
  POST .../chat/completions  对话；带 “/” 的模型 → 400 未开通；old-model-403 → 403；
                             no-think-model 收到思考参数 → 400（测试去参重试）
Gemini：GET /v1beta/models、POST /v1beta/models/<m>:generateContent
GET /last  最近一次对话请求（含完整请求体）；GET /log 所有对话请求
GET /kaggle-fixture.html  Kaggle 编辑器近似 DOM 夹具
用户消息含“请修复下面这个单元格的报错”→ 返回修复后的代码，否则返回固定示例代码。"""
import json, sys, pathlib
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = pathlib.Path(__file__).resolve().parent
KEY = 'test-key-not-secret'
LAST, LOG = {}, []

GEN_CODE = 'import platform\nprint("NBAC_OK", 6 * 7, platform.python_version() != "")\n'
FIX_CODE = 'x = 1 / 1  # 除数改成非 0\nprint("NBAC_FIXED", x)\n'
OPENAI_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'qwen3.8-max', 'kimi-k3', 'glm-5.3',
                 'MiniMax/MiniMax-M3', 'old-model-403', 'no-think-model',
                 'paraformer-v2', 'qwen-tts-latest', 'text-embedding-v4', 'wanx2.1-t2i-turbo']
GEMINI_MODELS = [('gemini-3.5-flash', ['generateContent']), ('gemini-3.6-flash', ['generateContent']),
                 ('gemini-3.8-flash', ['generateContent']), ('gemini-embedding-001', ['embedContent']),
                 ('imagen-4.0-generate-001', ['predict'])]
THINK_KEYS = ('enable_thinking', 'thinking_budget', 'reasoning_effort', 'thinking')

def answer(user_text):
    code = FIX_CODE if '请修复下面这个单元格的报错' in user_text else GEN_CODE
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
        if path.startswith('/kaggle-fixture.html'):
            return self.send(200, (HERE / 'kaggle_fixture.html').read_bytes(), 'text/html; charset=utf-8')
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
            user = ''.join(p.get('text', '') for c in body.get('contents', [])[-1:] for p in c.get('parts', []))
            rec = {'format': 'gemini', 'path': self.path, 'user': user, 'body': body,
                   'system': body.get('systemInstruction', {}).get('parts', [{}])[0].get('text', '')}
            LAST.clear(); LAST.update(rec); LOG.append(rec)
            return self.send(200, {'candidates': [{'content': {'role': 'model', 'parts': [
                {'text': '思考中…', 'thought': True}, {'text': answer(user)}]}}]})
        if self.path.endswith('/chat/completions'):
            if not self.bearer_ok():
                return self.send(401, {'error': {'message': 'Incorrect API key'}})
            msgs = body.get('messages', [])
            user = msgs[-1]['content'] if msgs else ''
            model = body.get('model', '')
            rec = {'format': 'openai', 'path': self.path, 'model': model, 'user': user, 'body': body,
                   'system': next((m['content'] for m in msgs if m['role'] == 'system'), '')}
            LAST.clear(); LAST.update(rec); LOG.append(rec)
            if '/' in model:
                return self.send(400, {'error': {'code': 'Model.AccessDenied', 'message': 'Model not activated: please activate the model in the console first'}})
            if model == 'old-model-403':
                return self.send(403, {'error': {'message': 'Access denied'}})
            if model == 'no-think-model' and any(k in body for k in THINK_KEYS):
                return self.send(400, {'error': {'message': "Unrecognized request argument supplied: enable_thinking"}})
            return self.send(200, {'choices': [{'message': {'role': 'assistant', 'content': answer(user)}}]})
        self.send(404, {'error': {'message': 'not found'}})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
