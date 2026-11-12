// 硬件信息：页面提示 / “检测硬件”单元格结果的合并、显示文字，以及给模型的硬件规则。
// 纯函数，不依赖 chrome.*，方便单元测试。

// “检测硬件”单元格：只读取信息，不安装、不修改任何东西；最后打印一行 NBAC_HW {json}
export const PROBE_CODE = `# 检测硬件（只读取信息，不安装任何东西）
import json, os, platform, shutil, subprocess
info = {"python": platform.python_version(), "cpu_count": os.cpu_count(), "vendor": "cpu", "devices": []}
try:
    import torch
    info["torch"] = torch.__version__
    info["cuda_build"] = getattr(torch.version, "cuda", None)
    info["hip_build"] = getattr(torch.version, "hip", None)
    if torch.cuda.is_available():
        info["vendor"] = "amd" if info["hip_build"] else "nvidia"
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            info["devices"].append({"name": p.name, "vram_gb": round(p.total_memory / 1024**3, 1)})
except Exception as e:
    info["torch_error"] = type(e).__name__ + ": " + str(e)[:120]
if info["vendor"] == "cpu":
    for tool, vendor, args in (("rocm-smi", "amd", ["--showproductname"]), ("nvidia-smi", "nvidia", ["--query-gpu=name,memory.total", "--format=csv,noheader"])):
        if shutil.which(tool):
            try:
                out = subprocess.run([tool] + args, capture_output=True, text=True, timeout=20).stdout
                info["vendor"] = vendor
                info["smi"] = out.strip()[:400]
                break
            except Exception as e:
                info[tool] = str(e)[:120]
print("NBAC_HW " + json.dumps(info, ensure_ascii=False))
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
    torchMissing: !d.torch, source: 'probe'
  };
}

// 多个 frame 的页面提示 + 已保存的检测结果 → 一个硬件对象。优先级：检测结果 > 页面文字 > 网址默认值
export function mergeHardware(probe, hints) {
  if (probe && probe.vendor) return probe;
  const list = (hints || []).filter(Boolean);
  const rank = (h) => (h.vendor === 'amd' || h.vendor === 'nvidia' ? 3 : h.vendor === 'gpu' ? 2 : 1) + (h.source === 'page' ? 0.5 : 0) + (h.model ? 0.2 : 0);
  list.sort((a, b) => rank(b) - rank(a));
  return list[0] || null;
}

export function hardwareLabel(hw) {
  if (!hw || !hw.vendor) return '未知（生成的代码会先自动检测）';
  const extra = [hw.model, hw.vramGB ? hw.vramGB + ' GB 显存' : ''].filter(Boolean).join('，');
  const base = { amd: 'AMD GPU（ROCm）', nvidia: 'NVIDIA GPU（CUDA）', cpu: '仅 CPU', gpu: 'GPU（厂商未知）' }[hw.vendor] || '未知';
  const src = hw.source === 'probe' ? '已检测' : hw.source === 'page' ? '页面提示' : '按平台推断';
  return base + (extra ? ' ' + extra : '') + ' · ' + src;
}

const AMD_RULES = 'AMD 显卡用的是 ROCm 版 PyTorch：它仍然使用 "cuda" 这套接口（torch.cuda.is_available()、device="cuda"、.to("cuda")），torch.version.hip 不为 None；' +
  '查看显卡用 rocm-smi（不要用 nvidia-smi）；不要安装只支持 NVIDIA CUDA 的包（bitsandbytes 的 CUDA 版、flash-attn、xformers 的 CUDA 轮子、cupy-cuda*、onnxruntime-gpu、nvidia-* 等），需要时选 ROCm/CPU 替代方案；' +
  '已有能用的 torch 就不要重装；确实要装时用 ROCm 轮子：%pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm6.x（把 6.x 换成和系统 ROCm 一致的版本，例如 rocm6.2），不要用默认的 CUDA 版。';

// 给模型的第 7 条规则
export function hardwareRule(hw) {
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
