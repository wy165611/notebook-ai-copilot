// 纯函数（不碰 DOM），给 page.js 用，也方便 node 单元测试（tests/unit_test.mjs 用 vm 加载本文件）。
(() => {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.__nbacHelpers) return;

  // 比较用：去掉 \r、每行行尾空白、首尾空行
  function normCode(t) {
    return String(t || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  }

  // 写进编辑器后核对：完全一致；或者超长单元格只渲染了前面一部分，渲染出来的部分完全一致
  function codeMatches(got, want) {
    const g0 = normCode(got), w0 = normCode(want);
    if (g0 === w0) return true;
    const g = g0.split('\n'), w = w0.split('\n');
    return g.length >= 20 && w.length > g.length && g.every((l, i) => (i === g.length - 1 ? w[i].startsWith(l) : l === w[i]));
  }

  // Monaco 的 .view-line：按 top 排序（DOM 顺序不一定是行号顺序），&nbsp; 还原成空格
  function joinViewLines(lines) {
    const arr = lines.slice();
    if (arr.some((l) => l.top != null && l.top !== '')) arr.sort((a, b) => (parseFloat(a.top) || 0) - (parseFloat(b.top) || 0));
    return arr.map((l) => String(l.text || '').replace(/\u00a0/g, ' ')).join('\n');
  }

  // ModelScope Code Editor（VS Code Notebook）的内核提示
  const KERNEL_FIX = '请点 Notebook 右上角的内核名，改选 /usr/local/bin/python（Python 3.11），然后再运行。';
  function vscodeKernelHint({ hasButton, label, pageText }) {
    if (/requires the ipykernel package|ipykernel (is )?not installed|No Pip installer available/i.test(pageText || '')) {
      return '内核不可用：当前 Python 环境没有 ipykernel，单元格跑不起来。' + KERNEL_FIX;
    }
    const l = String(label || '').trim();
    if (!hasButton || !l || /select kernel|选择内核/i.test(l)) return '还没有选内核。' + KERNEL_FIX;
    if (/(^|\s)(\/usr)?\/bin\/python3(\s|$)/.test(l)) {
      return '当前内核是 /usr/bin/python3：在 ModelScope 免费 CPU 实例上它没有 ipykernel，运行会报错。' + KERNEL_FIX;
    }
    return '';
  }

  // 按域名识别平台（只会在 manifest 匹配的网站上运行）。*.test 是本地测试用的假域名
  function platformFromHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (/(^|\.)aistudio\.baidu\.(com|test)$/.test(h)) return '飞桨 AI Studio';
    if (/(^|\.)modelscope\.(cn|test)$/.test(h) || /(^|\.)data\.aliyun\.com$/.test(h)) return 'ModelScope';
    if (/(^|\.)anruicloud\.(com|test)$/.test(h)) return '安睿云 JupyterLab';
    if (/kaggle/.test(h)) return 'Kaggle';
    return 'Jupyter';
  }

  root.__nbacHelpers = { normCode, codeMatches, joinViewLines, vscodeKernelHint, platformFromHost };
})();
