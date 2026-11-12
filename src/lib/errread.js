// VS Code 网页版 Notebook（ModelScope Code Editor、PAI-DSW WebIDE）的输出画在跨域 webview 里，扩展读不到。
// 单元格运行出错（状态栏 ✗）后，用户点「修复当前报错 / 根据运行结果继续」时，插入并运行下面这个只读的小单元格：
// 它从 IPython 记下的上一次异常（sys.last_value / last_traceback）取出报错，用 set_next_input(replace=True)
// 把这个单元格自己换成「# NBAC_ERR {...}」，扩展从单元格文字里读回来（和自动检测硬件的写回方式一样）。
// 不改用户的代码，不安装任何东西。
export const ERR_READ_CODE = `# 读取上一个单元格的报错（Notebook AI Copilot，只读；读完会把这个单元格换成报错摘要，可以删除）
def _nbac_last_error():
    import sys, json, re, traceback
    e = getattr(sys, "last_value", None)
    info = {"ok": e is None}
    if e is not None:
        frames = [f for f in traceback.extract_tb(getattr(sys, "last_traceback", None)) if "/IPython/" not in f.filename.replace("\\\\", "/")]
        tb = "Traceback (most recent call last):\\n" + "".join(traceback.format_list(frames)) + "".join(traceback.format_exception_only(type(e), e))
        for k in ("stderr", "output"):
            v = getattr(e, k, None)
            if v:
                tb += "\\n[%s]\\n%s" % (k, v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v))
        info.update(ename=type(e).__name__, evalue=str(e)[:500], tb=re.sub(r"\\x1b\\[[0-9;]*m", "", tb)[-3000:])
    get_ipython().set_next_input("# 上一次运行的报错（Notebook AI Copilot 已读取），可以删除这个单元格\\n# NBAC_ERR " + json.dumps(info, ensure_ascii=False), replace=True)
_nbac_last_error()
del _nbac_last_error
`;

// 读回的 NBAC_ERR 行 → 报错文字
export function parseErrLine(line) {
  const m = String(line || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j.ok) return { ok: true, text: '' };
    return { ok: false, text: (j.tb || ((j.ename || '') + ': ' + (j.evalue || ''))).trim() };
  } catch { return null; }
}
