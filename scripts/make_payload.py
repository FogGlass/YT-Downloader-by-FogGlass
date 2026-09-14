"""Build the installer payload, and wrap a stub executable around it.

The payload is a small container written by this script and read by the installer's
Rust side (`src-setup/src/payload.rs`):

    "YTDPAYLOAD1" | u32 entry count | entry headers … | deflate/raw data blocks …
    entry header: u16 name len | name | u64 original size | u64 compressed size | u8 method

Modes
-----
    payload  build <source-dir> <payload-file>
    wrap     <stub-exe> <payload-file> <output-exe>
    verify   <setup-exe>            # list entries and prove no development material

The build refuses to package anything that looks like development material, so a setup
file can never accidentally ship `node_modules`, a Rust `target` directory, `.git`, or
any cache.
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

BLOCK_MAGIC = b"YTDPAYLOAD1"
FOOTER_MAGIC = b"YTDSETUP"
FOOTER_LEN = 24

# Directory names that must never reach a production installer.
FORBIDDEN_DIRS = {
    "node_modules",
    "target",
    ".git",
    ".caches",
    "src",
    "src-tauri",
    "src-setup",
    "__pycache__",
    ".vite",
    "coverage",
}

# Files that are development artefacts rather than shipped content.
FORBIDDEN_SUFFIXES = (".log", ".tmp", ".part", ".ytdl", ".map", ".pdb")

# Anything whose name matches this is considered test material.
FORBIDDEN_MARKERS = ("-test", "test-", "screenshot", "ui-check", ".spec.", ".test.")

CHUNK = 1 << 20


def fail(message: str) -> None:
    print(f"错误：{message}", file=sys.stderr)
    raise SystemExit(1)


def collect(root: str) -> list[tuple[str, str]]:
    """Every file under `root`, as (relative posix path, absolute path)."""
    if not os.path.isdir(root):
        fail(f"源目录不存在：{root}")

    entries: list[tuple[str, str]] = []
    for base, dirs, files in os.walk(root):
        # Prune rather than filter, so a stray development directory is never walked.
        dirs[:] = sorted(
            name for name in dirs if name.lower() not in FORBIDDEN_DIRS
        )
        for name in sorted(files):
            full = os.path.join(base, name)
            relative = os.path.relpath(full, root).replace("\\", "/")
            entries.append((relative, full))
    entries.sort()
    return entries


def guard(entries: list[tuple[str, str]]) -> None:
    """Refuse to package development material."""
    problems: list[str] = []
    for relative, _ in entries:
        parts = [part.lower() for part in relative.split("/")]
        for part in parts:
            if part in FORBIDDEN_DIRS:
                problems.append(f"包含开发目录：{relative}")
        lowered = relative.lower()
        if lowered.endswith(FORBIDDEN_SUFFIXES):
            problems.append(f"包含开发/临时文件：{relative}")
        if any(marker in lowered for marker in FORBIDDEN_MARKERS):
            problems.append(f"包含测试相关文件：{relative}")
    if problems:
        for problem in problems[:20]:
            print(f"  - {problem}", file=sys.stderr)
        fail(f"载荷中检测到 {len(problems)} 项不应发布的内容")


def build_payload(source: str, output: str, level: int = 6) -> None:
    entries = collect(source)
    guard(entries)
    if not entries:
        fail("源目录为空。")

    header = bytearray()
    header += BLOCK_MAGIC
    header += struct.pack("<I", len(entries))

    blocks: list[bytes] = []
    raw_total = 0
    for relative, full in entries:
        compressor = zlib.compressobj(level, zlib.DEFLATED, -15)
        packed = bytearray()
        size = 0
        with open(full, "rb") as handle:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                packed += compressor.compress(chunk)
        packed += compressor.flush()

        name = relative.encode("utf-8")
        if len(name) > 65535:
            fail(f"路径过长：{relative}")

        header += struct.pack("<H", len(name))
        header += name
        header += struct.pack("<QQB", size, len(packed), 1)
        blocks.append(bytes(packed))
        raw_total += size

    with open(output, "wb") as handle:
        handle.write(header)
        for block in blocks:
            handle.write(block)

    packed_total = sum(len(block) for block in blocks) + len(header)
    print(
        f"载荷已生成：{output}\n"
        f"  文件数    : {len(entries)}\n"
        f"  原始大小  : {raw_total / 1048576:.1f} MB\n"
        f"  压缩后    : {packed_total / 1048576:.1f} MB "
        f"({packed_total / raw_total * 100:.0f}%)"
    )


def wrap(stub: str, payload: str, output: str) -> None:
    if not os.path.isfile(stub):
        fail(f"找不到安装器骨架：{stub}")
    if not os.path.isfile(payload):
        fail(f"找不到载荷：{payload}")

    stub_bytes = os.path.getsize(stub)
    payload_size = os.path.getsize(payload)

    with open(output, "wb") as target, open(stub, "rb") as stub_handle, open(
        payload, "rb"
    ) as payload_handle:
        while True:
            chunk = stub_handle.read(CHUNK)
            if not chunk:
                break
            target.write(chunk)
        while True:
            chunk = payload_handle.read(CHUNK)
            if not chunk:
                break
            target.write(chunk)
        target.write(FOOTER_MAGIC + struct.pack("<QQ", stub_bytes, payload_size))

    total = os.path.getsize(output)
    print(
        f"安装包已生成：{output}\n"
        f"  骨架      : {stub_bytes / 1048576:.1f} MB\n"
        f"  载荷      : {payload_size / 1048576:.1f} MB\n"
        f"  合计      : {total / 1048576:.1f} MB"
    )


def read_footer(path: str) -> tuple[int, int]:
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        handle.seek(size - FOOTER_LEN)
        footer = handle.read(FOOTER_LEN)
    if footer[:8] != FOOTER_MAGIC:
        fail("没有找到载荷标记，这可能是未封装的骨架文件。")
    offset, length = struct.unpack("<QQ", footer[8:])
    if offset + length + FOOTER_LEN != size:
        fail(f"载荷记录与文件大小不一致（{offset}+{length}+{FOOTER_LEN} != {size}）")
    return offset, length


def verify(path: str) -> None:
    """List the packaged entries and assert nothing development-related slipped in."""
    offset, length = read_footer(path)
    with open(path, "rb") as handle:
        handle.seek(offset)
        if handle.read(len(BLOCK_MAGIC)) != BLOCK_MAGIC:
            fail("载荷格式无法识别。")
        count = struct.unpack("<I", handle.read(4))[0]

        entries: list[tuple[str, int, int]] = []
        total_raw = 0
        for _ in range(count):
            name_len = struct.unpack("<H", handle.read(2))[0]
            name = handle.read(name_len).decode("utf-8")
            original, compressed, _method = struct.unpack("<QQB", handle.read(17))
            entries.append((name, original, compressed))
            total_raw += original

    print(f"安装包      : {path}")
    print(f"  文件大小  : {os.path.getsize(path) / 1048576:.1f} MB")
    print(f"  载荷大小  : {length / 1048576:.1f} MB")
    print(f"  解压后    : {total_raw / 1048576:.1f} MB")
    print(f"  条目数    : {len(entries)}")

    print("\n  顶层内容：")
    tops: dict[str, int] = {}
    for name, original, _ in entries:
        top = name.split("/")[0]
        tops[top] = tops.get(top, 0) + original
    for top, size in sorted(tops.items(), key=lambda item: -item[1]):
        print(f"    {top:<28} {size / 1048576:8.2f} MB")

    print("\n  内置运行库：")
    runtime = [entry for entry in entries if entry[0].startswith("runtime/")]
    for name, original, _ in sorted(runtime, key=lambda item: -item[1])[:6]:
        print(f"    {name:<46} {original / 1048576:8.2f} MB")
    print(f"    共 {len(runtime)} 个文件")

    guard([(name, "") for name, _, _ in entries])
    print("\n  未发现 node_modules / target / .git / .caches 等开发内容 ✓")

    for required in [
        "YTDownloader.exe",
        "runtime/FFMPEG-9.0/bin/ffmpeg.exe",
        "runtime/FFMPEG-9.0/bin/ffprobe.exe",
        "runtime/FFMPEG-9.0/bin/yt-dlp.exe",
    ]:
        present = any(name == required for name, _, _ in entries)
        print(f"  {'✓' if present else '✗'} {required}")
        if not present:
            fail(f"载荷中缺少必需文件：{required}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1

    mode = argv[1]
    if mode == "payload" and len(argv) == 4:
        build_payload(argv[2], argv[3])
    elif mode == "wrap" and len(argv) == 5:
        wrap(argv[2], argv[3], argv[4])
    elif mode == "verify" and len(argv) == 3:
        verify(argv[2])
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
