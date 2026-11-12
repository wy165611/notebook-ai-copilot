"""生成“测试专用”扩展副本：在发布用 manifest 基础上额外允许 127.0.0.1 / localhost，
以及仿 Kaggle 的 *.kaggle.test / *.kagglenet.test、仿 AI Studio 的 aistudio.baidu.test、仿 ModelScope 的 modelscope.test、仿安睿云的 *.anruicloud.test 测试域名（用 --host-resolver-rules 指向本机），
并加上 tabs 权限（测试脚本需要按 URL 找标签页）。发布用的 manifest.json 不改动。"""
import json, shutil, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/nbac-test-ext')

def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name in ['manifest.json', 'src', 'icons', '_locales']:
        p = ROOT / name
        (shutil.copytree if p.is_dir() else shutil.copy)(p, OUT / name)
    m = json.loads((ROOT / 'manifest.json').read_text())
    extra = ['http://127.0.0.1/*', 'http://localhost/*', 'http://*.kaggle.test/*', 'http://*.kagglenet.test/*', 'http://aistudio.baidu.test/*', 'http://modelscope.test/*', 'http://*.anruicloud.test/*', 'http://*.data.aliyun.test/*']
    for cs in m['content_scripts']:
        cs['matches'] += extra
    # selfhosted.test：只给主机权限、不在内容脚本匹配列表里（仿“自建 JupyterLab”，测侧边栏主动注入）
    # noperm.test：什么都没有（测“在此网站启用助手”按钮）
    m['host_permissions'] += extra + ['http://selfhosted.test/*']
    m['permissions'].append('tabs')
    m['name'] += ' (TEST BUILD)'
    (OUT / 'manifest.json').write_text(json.dumps(m, ensure_ascii=False, indent=2))
    print(OUT)

if __name__ == '__main__':
    main()
