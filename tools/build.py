"""零依赖打包正式插件：src/extension.ts -> .prg

Project Graph 扩展运行在 Web Worker + Blob URL，不能 import 其他模块，
所以源码刻意保持单文件、纯 JavaScript 语法，这里直接把它作为 extension.js 放进包里，
不经过 TypeScript 编译，也就不需要 npm / pnpm 网络。

.prg = ZIP，所有文件必须位于压缩包根目录，且必须包含 metadata.msgpack + extension.js。
"""

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def mp_str(value: str) -> bytes:
    raw = value.encode("utf-8")
    n = len(raw)
    if n < 32:
        return bytes([0xA0 | n]) + raw
    if n < 256:
        return bytes([0xD9, n]) + raw
    if n < 65536:
        return b"\xda" + n.to_bytes(2, "big") + raw
    return b"\xdb" + n.to_bytes(4, "big") + raw


def mp_value(value) -> bytes:
    if isinstance(value, str):
        return mp_str(value)
    if isinstance(value, dict):
        n = len(value)
        if n >= 16:
            raise ValueError("最小编码器只支持少于 16 个键的 map")
        out = bytes([0x80 | n])
        for key, item in value.items():
            out += mp_str(key) + mp_value(item)
        return out
    raise TypeError(f"不支持的类型: {type(value)}")


def main() -> None:
    metadata = json.loads((ROOT / "metadata.json").read_text(encoding="utf-8"))
    packed = mp_value(metadata)

    source = (ROOT / "src" / "extension.ts").read_text(encoding="utf-8")

    OUT.mkdir(parents=True, exist_ok=True)
    ext = metadata["extension"]
    target = OUT / f"{ext['id']}-{ext['version']}.prg"

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.msgpack", packed)
        zf.writestr("metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2))
        zf.writestr("extension.js", source)
        for name in ("icon.svg", "README.md"):
            path = ROOT / name
            if path.exists():
                zf.write(path, arcname=name)

    print(f"metadata.msgpack: {len(packed)} bytes")
    print(f"extension.js:     {len(source.encode('utf-8'))} bytes")
    print(f"package:          {target}")


if __name__ == "__main__":
    main()
