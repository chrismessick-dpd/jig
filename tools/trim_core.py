"""Trim an installed Arduino core to what Jig's boards build with, before the workflow caches it (docs/design.md,
*Building*). A smaller cache restores faster: on 2026-11-20 restoring the whole core took 32 s of an 84 s build.

    python tools/trim_core.py --data <jig_data checkout> --arduino ~/.arduino15 [--dry-run]

For the boards in boards.json it reads each board's build.series, build.mcu, build.fpu, and build.float-abi from the
board package's boards.txt, then removes from the installed core (boards.json's core id and version):
  - other series' HAL drivers, CMSIS device headers, and variants;
  - the compiler's libraries for other CPU setups (multilib), found by asking the compiler itself
    (arm-none-eabi-gcc ... -print-multi-directory) for each board's flags, plus its debugger and docs;
  - the SVD register files (only debuggers use them; the folder is left empty so the tool still counts as installed).
Nothing is removed outside the core's own folders. A board whose values it can't read leaves everything in place.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys


def size(p):
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def board_props(data):
    """{ board id: { series, mcu, fpu, float-abi } } from the board package's boards.txt files."""
    props = {}
    for bt in (data / "board" / "hardware").glob("*/*/boards.txt"):
        for line in bt.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^([A-Za-z0-9_]+)\.build\.(series|mcu|fpu|float-abi)=(.*)$", line.strip())
            if m:
                props.setdefault(m.group(1), {})[m.group(2)] = m.group(3).strip()
    return props


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--arduino", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    data, home = pathlib.Path(a.data), pathlib.Path(a.arduino).expanduser()
    cfg = json.loads((data / "boards.json").read_text(encoding="utf-8"))
    vendor, arch = cfg["core"]["id"].split(":")
    core = home / "packages" / vendor / "hardware" / arch / cfg["core"]["version"]
    tools = home / "packages" / vendor / "tools"
    if not core.is_dir():
        sys.exit("No core at %s" % core)

    props = board_props(data)
    series, flags = set(), set()
    for b in (cfg.get("boards") or {}).values():
        bid = b["fqbn"].split(":")[2]
        p = props.get(bid) or {}
        if not all(p.get(k) for k in ("series", "mcu")):
            print("Board %s: no build.series or build.mcu in boards.txt; nothing trimmed." % bid)
            return
        series.add(p["series"])
        flags.add(("-mcpu=" + p["mcu"], p.get("fpu", ""), p.get("float-abi", "")))
    print("Keeping series %s and CPU setups %s" % (", ".join(sorted(series)), "; ".join(" ".join(f for f in x if f) for x in sorted(flags))))

    gone = []

    def drop(p):
        gone.append(p)

    # The core: other series' drivers, device headers, and variants.
    drivers = core / "system" / "Drivers"
    for d in drivers.glob("STM32*"):
        if d.is_dir() and not any(d.name.startswith(s) for s in series):
            drop(d)
    for d in (drivers / "CMSIS" / "Device" / "ST").glob("*"):
        if d.is_dir() and d.name not in series:
            drop(d)
    for d in (core / "variants").glob("*"):
        if d.is_dir() and d.name not in series:
            drop(d)

    # The compiler: only the multilib folders these boards link with, and no debugger or docs.
    for gcc_root in sorted((tools / "xpack-arm-none-eabi-gcc").glob("*")):
        gcc = next(iter(sorted(gcc_root.glob("bin/arm-none-eabi-gcc*"))), None)
        if not gcc:
            continue
        keep = set()
        for f in flags:
            r = subprocess.run([str(gcc), "-mthumb"] + [x for x in f if x] + ["-print-multi-directory"], capture_output=True, text=True)
            d = r.stdout.strip()
            if r.returncode or not d:
                print("The compiler didn't name a multilib folder for %s; nothing trimmed there." % " ".join(f))
                keep = None
                break
            keep.add(d.replace("\\", "/"))
        if keep:
            libdirs = [gcc_root / "arm-none-eabi" / "lib"] + sorted((gcc_root / "lib" / "gcc" / "arm-none-eabi").glob("*"))
            for base in libdirs:
                for sub in (base / "thumb").rglob("*") if (base / "thumb").is_dir() else []:
                    if not sub.is_dir():
                        continue
                    rel = sub.relative_to(base).as_posix()
                    # Keep a folder on the way to a kept one, and everything under a kept one.
                    if any(k == rel or k.startswith(rel + "/") or rel.startswith(k + "/") for k in keep):
                        continue
                    if not any(sub.is_relative_to(g) for g in gone):
                        drop(sub)
            print("Compiler libraries kept: %s" % ", ".join(sorted(keep)))
        for pat in ("bin/arm-none-eabi-gdb*", "bin/arm-none-eabi-lto-dump*", "share/doc", "share/man", "share/info", "share/gdb"):
            gone.extend(gcc_root.glob(pat))

    # SVD files: emptied, not removed, so the tool still counts as installed.
    for v in (tools / "STM32_SVD").glob("*"):
        gone.extend(x for x in v.iterdir())

    before = size(home / "packages" / vendor)
    freed = sum(size(p) if p.is_dir() else p.stat().st_size for p in gone if p.exists())
    print("%d folders and files, %.0f MB of %.0f MB" % (len(gone), freed / 1e6, before / 1e6))
    if a.dry_run:
        return
    for p in gone:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()
    print("Now %.0f MB" % (size(home / "packages" / vendor) / 1e6))


if __name__ == "__main__":
    main()
