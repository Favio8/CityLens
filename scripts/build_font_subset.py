"""
构建期字体子集化脚本（一次性，产物提交入库）。

输入：.fonts-src/*.ttf（OFL 授权源文件，仅构建时使用，不参与运行）
输出：client/public/fonts/*.woff2（自托管，无任何外部 CDN）

字符集 = GB2312 全部汉字与符号 + city_dictionary.json 中出现的中文 + 常用标点/拉丁字符。
如需覆盖新生成的叙事文本，重跑本脚本并重新子集化即可。

用法: python scripts/build_font_subset.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".fonts-src"
OUT = ROOT / "client" / "public" / "fonts"

BASE_CHARS: set[str] = set()


def add_gb2312(chars: set[str]) -> None:
    """枚举 GB2312 全部有效双字节字符。"""
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                ch = bytes([high, low]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            chars.add(ch)


def add_ascii(chars: set[str]) -> None:
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update("“”‘’—…·、。，；：？！（）《》〈〉「」『』【】〔〕～・")


def add_dictionary(chars: set[str]) -> None:
    path = ROOT / "server" / "data" / "city_dictionary.json"
    if not path.exists():
        print(f"[warn] 缺少 {path}，跳过城市词典字符", file=sys.stderr)
        return
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("cities", raw) if isinstance(raw, dict) else raw
    for item in items:
        for key in ("standardName", "province", "summary", "englishName"):
            value = item.get(key)
            if isinstance(value, str):
                chars.update(value)
        for alias in item.get("aliases", []) or []:
            if isinstance(alias, str):
                chars.update(alias)
            elif isinstance(alias, dict):
                chars.update(str(alias.get("displayAlias") or alias.get("key") or ""))


def write_charset(chars: set[str]) -> Path:
    text = "".join(sorted(chars))
    path = SRC / "charset.txt"
    path.write_text(text, encoding="utf-8")
    print(f"[info] 字符集 {len(chars)} 个字符 → {path}")
    return path


def subset(source: Path, target: Path, text_file: Path, extra: list[str]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(source),
        f"--text-file={text_file}",
        f"--output-file={target}",
        "--flavor=woff2",
        "--layout-features=*",
        "--name-IDs=*",
        "--glyph-names",
        "--notdef-glyph",
        "--notdef-outline",
        "--recommended-glyphs",
        *extra,
    ]
    subprocess.run(cmd, check=True)
    print(f"[ok] {source.name} → {target.relative_to(ROOT)} ({target.stat().st_size / 1024:.1f} KB)")


def main() -> None:
    chars: set[str] = set()
    add_gb2312(chars)
    add_ascii(chars)
    add_dictionary(chars)
    text_file = write_charset(chars)

    latin = SRC / "latin.txt"
    latin_chars = set(chars)
    # 拉丁字体只保留 ASCII 与常用符号，避免无意义膨胀
    latin_chars = {c for c in latin_chars if ord(c) < 0x2000}
    latin.write_text("".join(sorted(latin_chars)), encoding="utf-8")

    subset(SRC / "NotoSerifSC.ttf", OUT / "NotoSerifSC-subset.woff2", text_file, [])
    subset(SRC / "Inter.ttf", OUT / "Inter-subset.woff2", latin, ["--layout-features=*"])
    subset(SRC / "JetBrainsMono.ttf", OUT / "JetBrainsMono-subset.woff2", latin, [])


if __name__ == "__main__":
    main()
