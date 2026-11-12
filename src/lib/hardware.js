// 硬件信息：页面提示 / “检测硬件”单元格结果的合并、显示文字，以及给模型的硬件规则。
// 纯函数，不依赖 chrome.*，方便单元测试。

// “检测硬件”单元格：只读取信息，不安装、不修改任何东西；最后打印一行 NBAC_HW {json}
export const PROBE_CODE = `# 检测硬件（只读取信息，不安装任何东西；变量都放在函数里，不影响你的代码）
def _nbac_probe():
    import json, os, platform, shutil, subprocess, sys
    info = {"python": platform.python_version(), "vendor": "cpu", "devices": []}
    # CPU 核数：容器里以 cgroup 限额为准
    n = os.cpu_count()
    try: n = len(os.sched_getaffinity(0))
    except Exception: pass
    for f in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"):
        try:
            parts = open(f).read().split()
            if f.endswith("cpu.max"): q, per = parts[0], parts[1]
            else: q, per = parts[0], open("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read().split()[0]
            if q not in ("max", "-1") and int(q) > 0: n = min(n or 9999, max(1, round(int(q) / int(per))))
            break
        except Exception: pass
    info["cpu_count"] = n
    # 内存：容器里以 cgroup 限额为准
    tot = None
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal"): tot = int(line.split()[1]) * 1024; break
    except Exception:
        try: tot = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except Exception: pass
    for f in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            v = open(f).read().strip()
            if v != "max" and int(v) > 0 and int(v) < (tot or 1 << 62): tot = int(v)
            break
        except Exception: pass
    info["ram_gb"] = round(tot / 1024 ** 3, 1) if tot else None
    # 显卡：先用 nvidia-smi / rocm-smi（不会在你的进程里占显存），都没有再看 torch
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20).stdout
            for line in out.strip().splitlines():
                name, _, mem = line.rpartition(",")
                if name.strip():
                    info["devices"].append({"name": name.strip(), "vram_gb": round(float(mem) / 1024, 1) if mem.strip().replace(".", "").isdigit() else None})
            if info["devices"]: info["vendor"] = "nvidia"
        except Exception as e: info["nvidia-smi"] = str(e)[:120]
    if not info["devices"] and shutil.which("rocm-smi"):
        try:
            out = subprocess.run(["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--json"], capture_output=True, text=True, timeout=20).stdout
            info["vendor"] = "amd"
            try:
                for card, d in json.loads(out).items():
                    if not str(card).lower().startswith("card"): continue
                    name = next((str(v) for k, v in d.items() if k.lower() in ("card series", "card model", "marketing name", "card sku") and str(v).strip()), "")
                    vram = next((v for k, v in d.items() if "vram total memory" in k.lower()), None)
                    info["devices"].append({"name": name, "vram_gb": round(int(vram) / 1024 ** 3, 1) if str(vram or "").isdigit() else None})
            except Exception: info["smi"] = out.strip()[:400]
        except Exception as e: info["rocm-smi"] = str(e)[:120]
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda_build"] = getattr(torch.version, "cuda", None)
        info["hip_build"] = getattr(torch.version, "hip", None)
        if not info["devices"] and torch.cuda.is_available():
            info["vendor"] = "amd" if info["hip_build"] else "nvidia"
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                info["devices"].append({"name": p.name, "vram_gb": round(p.total_memory / 1024 ** 3, 1)})
    except Exception as e:
        info["torch_error"] = type(e).__name__ + ": " + str(e)[:120]
    print("NBAC_HW " + json.dumps(info, ensure_ascii=False))
_nbac_probe()
del _nbac_probe
`;

// 从输出文字里取最后一行 NBAC_HW {...}，返回统一格式的硬件对象或 null
export function parseProbeOutput(text) {
  const all = String(text || '').match(/NBAC_HW\s*(\{[^\n]*\})/g);
  if (!all) return null;
  let d;
  try { d = JSON.parse(all[all.length - 1].replace(/^NBAC_HW\s*/, '')); } catch { return null; }
  const vendor = ['amd', 'nvidia', 'cpu'].includes(d.vendor) ? d.vendor : 'cpu';
  const devs = Array.isArray(d.devices) ? d.devices : [];
  let model = devs.length ? String(devs[0].name || '') : '';
  if (!model && d.smi) {
    const m = String(d.smi).match(/(?:Card series|Card SKU|Card model|Marketing Name)\s*:\s*([^\n]+)/i) || String(d.smi).match(/^([^,\n]+),/);
    if (m) model = m[1].trim();
  }
  if (devs.length > 1) model += ' ×' + devs.length;
  return {
    vendor, model: model.slice(0, 60), vramGB: devs.length && devs[0].vram_gb ? Number(devs[0].vram_gb) : null,
    torch: d.torch || null, hip: d.hip_build || null, cuda: d.cuda_build || null,
    ramGB: Number(d.ram_gb) > 0 ? Number(d.ram_gb) : null,
    cpuCores: Number(d.cpu_count) > 0 ? Number(d.cpu_count) : null,
    torchMissing: !d.torch, source: 'probe'
  };
}

// 多个 frame 的页面提示 + 已保存的检测结果 → 一个硬件对象。优先级：检测结果 > 页面文字 > 网址默认值
export function mergeHardware(probe, hints) {
  const list = (hints || []).filter(Boolean);
  const rank = (h) => (h.vendor === 'amd' || h.vendor === 'nvidia' ? 3 : h.vendor === 'gpu' ? 2 : 1) + (h.source === 'page' ? 0.5 : 0) + (h.model ? 0.2 : 0);
  list.sort((a, b) => rank(b) - rank(a));
  const best = list[0] || null;
  if (probe && probe.vendor) {
    // 检测代码没找到 GPU、也没有 torch 可确认（比如 rocm-smi 不在 PATH），但页面明确写了 AMD/NVIDIA：显卡按页面，CPU/内存按检测结果
    if (probe.vendor === 'cpu' && probe.torchMissing && best && (best.vendor === 'amd' || best.vendor === 'nvidia')) {
      return { ...best, ramGB: probe.ramGB || null, cpuCores: probe.cpuCores || null, torchMissing: probe.torchMissing, source: best.source };
    }
    return probe;
  }
  return best;
}

export function hardwareLabel(hw) {
  if (!hw || !hw.vendor) return '未知（生成的代码会先自动检测；也可以点「+ → 检测硬件」）';
  const extra = [hw.model, hw.vramGB ? hw.vramGB + ' GB 显存' : ''].filter(Boolean).join('，');
  const base = { amd: 'AMD GPU（ROCm）', nvidia: 'NVIDIA GPU（CUDA）', cpu: '仅 CPU', gpu: 'GPU（厂商未知）' }[hw.vendor] || '未知';
  const src = hw.source === 'probe' ? '已检测' : hw.source === 'page' ? '页面提示' : '按平台推断';
  const sys = [hw.cpuCores ? hw.cpuCores + ' 核 CPU' : '', hw.ramGB ? hw.ramGB + ' GB 内存' : ''].filter(Boolean).join('，');
  return base + (extra ? ' ' + extra : '') + (sys ? ' · ' + sys : '') + ' · ' + src;
}

const AMD_RULES = 'AMD 显卡用的是 ROCm 版 PyTorch：它仍然使用 "cuda" 这套接口（torch.cuda.is_available()、device="cuda"、.to("cuda")），torch.version.hip 不为 None；' +
  '查看显卡用 rocm-smi（不要用 nvidia-smi）；不要安装只支持 NVIDIA CUDA 的包（bitsandbytes 的 CUDA 版、flash-attn、xformers 的 CUDA 轮子、cupy-cuda*、onnxruntime-gpu、nvidia-* 等），需要时选 ROCm/CPU 替代方案；' +
  '已有能用的 torch 就不要重装；确实要装时用 ROCm 轮子：%pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm6.x（把 6.x 换成和系统 ROCm 一致的版本，例如 rocm6.2），不要用默认的 CUDA 版。';

function resourceNote(hw) {
  if (!hw || !(hw.cpuCores || hw.ramGB)) return '';
  return `CPU ${hw.cpuCores || '?'} 核、内存 ${hw.ramGB || '?'} GB：DataLoader 的 num_workers 不超过 CPU 核数，数据量、batch size 要放得进内存${hw.vramGB ? '和每张卡 ' + hw.vramGB + ' GB 显存' : ''}。`;
}

// 给模型的第 7 条规则
export function hardwareRule(hw) {
  return baseRule(hw) + resourceNote(hw);
}

function baseRule(hw) {
  const name = hw && hw.model ? `（${hw.model}${hw.vramGB ? '，' + hw.vramGB + ' GB 显存' : ''}）` : '';
  if (hw && hw.vendor === 'amd') {
    return `7. 运行环境：AMD GPU${name}，使用 ROCm。` + AMD_RULES + '用到 GPU 的代码开头打印 torch.cuda.get_device_name(0) 确认。' +
      (hw.torchMissing ? '检测时没有找到 torch，需要时按上面的 ROCm 方式安装。' : '');
  }
  if (hw && hw.vendor === 'nvidia') {
    return `7. 运行环境：NVIDIA GPU${name}，使用 CUDA：device="cuda"，可以用 nvidia-smi。已有能用的 torch 就不要重装。`;
  }
  if (hw && hw.vendor === 'cpu' && hw.source === 'probe') {
    return '7. 运行环境：没有可用的 GPU，只有 CPU：用 device="cpu"，训练时调小数据量 / batch / epoch，不要安装 CUDA 版的包。' +
      (hw.torchMissing ? '环境里还没有 torch，需要时先 %pip install torch（CPU 版即可）。' : '');
  }
  return '7. 硬件未知：用到 PyTorch / GPU 的代码，开头先加一段设备检测再统一用 device：' +
    'import torch；如果 torch.cuda.is_available() 为真则 device="cuda"，并用 torch.version.hip（AMD ROCm）/ torch.version.cuda（NVIDIA CUDA）判断厂商，打印 torch.cuda.get_device_name(0)；否则 device="cpu"。' +
    '如果是 AMD：' + AMD_RULES;
}
