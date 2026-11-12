"""把 stage0/ 打包成可直接安装的 .prg 扩展。

.prg 本质是 ZIP，所有文件必须在压缩包根目录；
metadata.msgpack 是 MessagePack 二进制，这里用最小编码器生成，不依赖第三方包。
"""

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAGE = ROOT / "stage0"
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
            raise ValueError("本最小编码器只支持少于 16 个键的 map")
        out = bytes([0x80 | n])
        for key, item in value.items():
            out += mp_str(key) + mp_value(item)
        return out
    raise TypeError(f"不支持的类型: {type(value)}")


def main() -> None:
    metadata = json.loads((STAGE / "metadata.json").read_text(encoding="utf-8"))
    packed = mp_value(metadata)
    (STAGE / "metadata.msgpack").write_bytes(packed)

    ext = metadata["extension"]
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{ext['id']}-{ext['version']}.prg"

    names = ["metadata.msgpack", "metadata.json", "extension.js", "icon.svg", "README.md"]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            path = STAGE / name
            if path.exists():
                zf.write(path, arcname=name)

    print(f"metadata.msgpack: {len(packed)} bytes")
    print(f"package: {target}")


if __name__ == "__main__":
    main()
