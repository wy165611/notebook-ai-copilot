// 纯函数（不碰 DOM），给 page.js 用，也方便 node 单元测试（tests/unit_test.mjs 用 vm 加载本文件）。
(() => {
  const root = typeof window !== 'undefined' ? window : globalThis;
  const BUILD = '0.1.14'; // 和 manifest 的 version 一致；旧版留在网页里的 helpers 会被替换
  if (root.__nbacHelpers && root.__nbacHelpers.build === BUILD) return;

  // 比较用：去掉 \r、每行行尾空白、首尾空行
  function normCode(t) {
    return String(t || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  }

  // 写进编辑器后核对：完全一致；或者超长单元格只渲染了前面一部分，渲染出来的部分完全一致
  function codeMatches(got, want) {
    const g0 = normCode(got), w0 = normCode(want);
    if (g0 === w0) return true;
    const g = g0.split('\n'), w = w0.split('\n');
    if (g.length >= 20 && w.length > g.length && g.every((l, i) => (i === g.length - 1 ? w[i].startsWith(l) : l === w[i]))) return true;
    // 写完后光标在末尾，编辑器滚到底部只渲染了最后几行：渲染出来的是原文末尾连续的几行（含最后一行），也算写对
    const off = w.length - g.length;
    return g.length >= 3 && off > 0 && g.every((l, i) => (i === 0 ? l.trim() === w[off].trim() : l === w[off + i]));
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
    // ModelScope GPU 实例（阿里云 PAI-DSW）：dsw-gateway-*.data.aliyun.com/dsw-xxxx/lab，JupyterLab 界面
    if (/(^|\.)data\.aliyun\.(com|test)$/.test(h)) return 'ModelScope DSW';
    if (/(^|\.)modelscope\.(cn|test)$/.test(h)) return 'ModelScope';
    if (/(^|\.)anruicloud\.(com|test)$/.test(h)) return '安睿云 JupyterLab';
    if (/kaggle/.test(h)) return 'Kaggle';
    return 'Jupyter';
  }

  // 从页面上的文字（平台顶栏、实例规格、加速器选择等）和网址里猜硬件。
  // 只是提示：真正的硬件以“检测硬件”单元格的运行结果为准。返回 {vendor: 'amd'|'nvidia'|'cpu'|'gpu', model, vramGB, source, evidence} 或 null
  function parseHardwareHints({ text, url, extensions }) {
    // AMD 的 CPU（EPYC、Ryzen 等，云平台的实例规格里很常见）不是 AMD 显卡：先去掉
    const t = String(text || '').replace(/\s+/g, ' ').slice(0, 30000)
      .replace(/\bAMD\s*(?:®\s*)?(?:EPYC|Ryzen|Threadripper|Opteron|Athlon|Phenom)\b(?:\s*(?:™|\(TM\)))?(?:\s*[\w-]+){0,3}/gi, ' ')
      .replace(/\b(?:EPYC|Ryzen|Threadripper)\b/gi, ' ');
    let u = null;
    try { u = new URL(url); } catch { /* ignore */ }
    const amdRe = /\bAMD\b|Radeon|\bROCm\b|\bInstinct\b|\bMI(?:50|60|100|210|250X?|300[AX]?|325X|350X?)\b/gi;
    const nvStrong = /NVIDIA|GeForce|\bRTX\s?\d{3,4}\b|\bTesla\b|\b(?:A100|A800|H100|H800|H200|V100|P100|A6000|RTX\s?A\d{4}|L40S?)\b/gi;
    const nvWeak = /GPU\s*[:：]?\s*(?:Tesla\s+)?(T4|L4|A10G?|A30|L20|H20|P40|K80)\b/gi;
    const amdHits = t.match(amdRe) || [];
    const nvHits = (t.match(nvStrong) || []).concat(t.match(nvWeak) || []);
    let vendor = null;
    if (amdHits.length && amdHits.length >= nvHits.length) vendor = 'amd';
    else if (nvHits.length) vendor = 'nvidia';
    let model = '';
    if (vendor === 'amd') {
      const m = t.match(/\b(Radeon\s+(?:PRO\s+|RX\s+|VII\b)?[A-Z]?\d{3,4}\s?(?:XTX|XT|GRE|X)?|Instinct\s+MI\d{2,3}[A-Z]?|MI(?:50|60|100|210|250X?|300[AX]?|325X|350X?))\b/i);
      if (m) model = m[1].trim();
    } else if (vendor === 'nvidia') {
      const m = t.match(/\b((?:GeForce\s+)?RTX\s?A?\d{3,4}(?:\s?Ti)?|Tesla\s+[A-Z]\d{1,3}|A100|A800|H100|H800|H200|V100|P100|A6000|L40S?)\b/i) ||
        t.match(/GPU\s*[:：]?\s*(?:Tesla\s+)?(T4|L4|A10G?|A30|L20|H20|P40|K80)\b/i);
      if (m) model = m[1].trim();
      const x = t.match(/GPU\s*[:：]?\s*(?:Tesla\s+)?(?:T4|P100|V100|A100|L4)\s*[x×*]\s*(\d)/i);
      if (x && model) model += ' ×' + x[1];
    }
    let vramGB = null;
    const v = t.match(/(?:VRAM|显存)\s*[:：]?\s*(?:[\d.]+\s*(?:GB|GiB|G)?\s*\/\s*)?([\d.]+)\s*(?:GB|GiB|G)\b/i) ||
      t.match(/([\d.]+)\s*(?:GB|GiB|G)\s*(?:VRAM|显存)/i);
    if (v) vramGB = parseFloat(v[1]);
    if (vendor) return { vendor, model, vramGB, source: 'page', evidence: (vendor === 'amd' ? amdHits : nvHits).slice(0, 3).join(', ') };
    // JupyterLab 装的插件名：安睿云的 AMD 一键镜像带 @amd-oneclick/resource-status 等
    const ext = (extensions || []).map(String).filter(n => /(^|[@/_-])amd([/_-]|$)|rocm/i.test(n));
    if (ext.length) return { vendor: 'amd', model: '', vramGB: null, source: 'jupyterlab', evidence: ext.slice(0, 2).join(', ') };
    // 飞桨 AI Studio：网址里的集群名，如 /bj-cpu-01/ 表示 CPU 环境
    if (u && /(^|\.)aistudio\.baidu\.com$/.test(u.hostname) && /^\/[a-z]+-cpu-\d+\//i.test(u.pathname)) {
      return { vendor: 'cpu', model: '', vramGB: null, source: 'url', evidence: u.pathname.split('/')[1] };
    }
    // 网址里的加速器类型（ModelScope：acceleratorType=CPU / GPU）
    const acc = u && (u.searchParams.get('acceleratorType') || u.searchParams.get('accelerator'));
    if (acc && /^cpu$/i.test(acc)) return { vendor: 'cpu', model: '', vramGB: null, source: 'url', evidence: 'acceleratorType=' + acc };
    if (acc && /gpu/i.test(acc)) return { vendor: 'nvidia', model: '', vramGB: null, source: 'url', evidence: 'acceleratorType=' + acc };
    // 只看到“GPU / 显存”字样，没有厂商
    if (/\bGPU\b/.test(t) && /VRAM|显存/i.test(t)) return { vendor: 'gpu', model: '', vramGB, source: 'page', evidence: 'GPU/VRAM' };
    return null;
  }

  // 输出文字看起来像报错（Python traceback、%%bash 非 0 退出、pip 的 ERROR 等）
  function looksLikeError(text) {
    const t = String(text || '');
    return /Traceback \(most recent call last\)|^\s*\w*(?:Error|Exception)\b[^\n]*(?::|$)|CalledProcessError|returned non-zero exit status|command not found|No such file or directory|^ERROR:/m.test(t);
  }

  root.__nbacHelpers = { build: BUILD, normCode, codeMatches, joinViewLines, vscodeKernelHint, platformFromHost, parseHardwareHints, looksLikeError };
})();
