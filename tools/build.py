"""Build one Jig project with arduino-cli and write its result (docs/design.md, *Building*).

    python tools/build.py --data <jig_data checkout> --project <id> --commit <sha> --out <dir>
                          [--cli arduino-cli] [--build-cache <dir>]

Writes <out>/<id>/<commit>.json always, and <out>/<id>/<commit>.bin when the build passed. It never
raises for a bad sketch or a failed compile: the result says so. It exits 0 unless its own arguments are
wrong, so the workflow builds every changed project and publishes every result.

The board and its FQBN come only from boards.json, never from the project's files, and arduino-cli runs
without a shell, so nothing in a project reaches the command line except its file names, which are
checked first.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

FORMAT = "jig.build/1"
LOG_MAX = 64 * 1024
FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$")
EXTS = {".ino", ".h", ".hpp", ".c", ".cpp", ".S"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
# gcc: "path:line:col: severity: text" (col optional); the linker: "path:(.text+0x10): undefined reference to ..."
MSG_RE = re.compile(r"^(?P<file>.+?):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<sev>fatal error|error|warning|note):\s*(?P<text>.*)$")
LINK_RE = re.compile(r"^(?P<file>.+?):(?:\(.*?\)|\d+):\s*(?P<text>(?:undefined reference|multiple definition).*)$")
REGION_RE = re.compile(r"region `?(?P<region>\w+)'? overflowed by (?P<n>\d+) bytes")


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def short_path(path, roots):
    """A message's file as the page shows it: a sketch file by its name, else relative to a known root."""
    p = str(path).replace("\\", "/")
    for prefix, label in roots:
        pre = str(prefix).replace("\\", "/").rstrip("/") + "/"
        if p.lower().startswith(pre.lower()):
            rest = p[len(pre):]
            return rest if not label else label + "/" + rest
    m = re.search(r"/packages/(.+)$", p)
    return m.group(1) if m else p.rsplit("/", 1)[-1]


def parse_messages(text, roots):
    out, seen = [], set()
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        m = MSG_RE.match(line)
        if m:
            sev = "error" if m.group("sev") == "fatal error" else m.group("sev")
            msg = {"file": short_path(m.group("file"), roots), "line": int(m.group("line")),
                   "col": int(m.group("col")) if m.group("col") else None, "severity": sev, "text": m.group("text").strip()}
        else:
            m = LINK_RE.match(line)
            if m:
                msg = {"file": short_path(m.group("file"), roots), "line": None, "col": None, "severity": "error", "text": m.group("text").strip()}
            else:
                r = REGION_RE.search(line)
                if not r:
                    continue
                msg = {"file": None, "line": None, "col": None, "severity": "error",
                       "text": "The firmware is %s bytes too big for %s" % (r.group("n"), r.group("region"))}
        key = (msg["file"], msg["line"], msg["col"], msg["severity"], msg["text"])
        if key not in seen:
            seen.add(key)
            out.append(msg)
    return out


def trim(text):
    text = text or ""
    if len(text) <= LOG_MAX:
        return text
    return text[: LOG_MAX // 2] + "\n…trimmed…\n" + text[-LOG_MAX // 2:]


def sketch_files(proj_dir, main):
    """The sketch's files, checked. Returns (main .ino name, [file names])."""
    sk = proj_dir / "sketch"
    if not sk.is_dir():
        raise ValueError("The project has no sketch folder.")
    names = sorted(p.name for p in sk.iterdir() if p.is_file())
    bad = [n for n in names if not FILE_RE.match(n) or pathlib.Path(n).suffix not in EXTS]
    if bad:
        raise ValueError("Files Jig doesn't build: " + ", ".join(bad) + ". Use letters, digits, _, -, and . in names, ending .ino, .h, .hpp, .c, .cpp, or .S.")
    inos = [n for n in names if n.endswith(".ino")]
    if main:
        if main not in inos:
            raise ValueError("The project's main file, " + main + ", isn't in its sketch.")
    elif len(inos) == 1:
        main = inos[0]
    else:
        raise ValueError("The sketch needs exactly one .ino file, or project.json's main naming one." if inos else "The sketch has no .ino file.")
    return main, names


def build(data, project, commit, out, cli, cache):
    data = pathlib.Path(data).resolve()
    started, t0 = now(), time.time()
    result = {"format": FORMAT, "project": project, "commit": commit, "startedAt": started, "ok": False, "messages": [], "log": ""}
    out_dir = pathlib.Path(out) / project
    out_dir.mkdir(parents=True, exist_ok=True)

    def finish(**kw):
        result.update(kw)
        result["seconds"] = round(time.time() - t0, 1)
        (out_dir / (commit + ".json")).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
        return result

    try:
        boards = read_json(data / "boards.json")
        proj = read_json(data / "projects" / project / "project.json")
    except (OSError, ValueError) as e:
        return finish(messages=[{"file": None, "line": None, "col": None, "severity": "error", "text": "Couldn't read the project: %s" % e}])
    board_id = proj.get("board")
    board = (boards.get("boards") or {}).get(board_id) if isinstance(board_id, str) else None
    core = boards.get("core") or {}
    result.update(board=board_id, name=proj.get("name"))
    if not board:
        return finish(messages=[{"file": None, "line": None, "col": None, "severity": "error", "text": "Jig has no board called %r." % board_id}])
    fqbn = board["fqbn"]
    result.update(fqbn=fqbn, core="%s@%s" % (core.get("id"), core.get("version")))
    try:
        result["boardPackage"] = read_json(data / "board" / "SOURCE.json")
    except (OSError, ValueError):
        result["boardPackage"] = None
    try:
        main, names = sketch_files(data / "projects" / project, proj.get("main"))
    except ValueError as e:
        return finish(messages=[{"file": None, "line": None, "col": None, "severity": "error", "text": str(e)}])

    with tempfile.TemporaryDirectory(prefix="jig-") as tmp:
        # arduino-cli rebuilds everything when the sketch's folder changes, so with a build cache every
        # project builds from one fixed folder, its main file renamed to sketch.ino (and named back in
        # the messages). That keeps the compiled core and libraries between builds.
        stem = "sketch" if cache else main[:-4]
        sk = (pathlib.Path(cache) / "sketch" / stem) if cache else pathlib.Path(tmp) / stem
        if sk.exists():
            shutil.rmtree(sk)
        sk.mkdir(parents=True)
        for n in names:
            shutil.copyfile(data / "projects" / project / "sketch" / n, sk / (stem + ".ino" if n == main else n))
        bin_dir = pathlib.Path(tmp) / "out"
        env = dict(os.environ, ARDUINO_DIRECTORIES_USER=str(data / "board"))
        args = [cli, "compile", "--fqbn", fqbn, "--json", "--warnings", "default", "--output-dir", str(bin_dir)]
        if cache:
            bp = pathlib.Path(cache) / re.sub(r"[^A-Za-z0-9_.-]", "_", fqbn)
            bp.mkdir(parents=True, exist_ok=True)
            args += ["--build-path", str(bp)]
        args.append(str(sk))
        try:
            p = subprocess.run(args, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
        except (OSError, subprocess.TimeoutExpired) as e:
            return finish(messages=[{"file": None, "line": None, "col": None, "severity": "error", "text": "arduino-cli didn't run: %s" % e}])
        try:
            j = json.loads(p.stdout)
        except ValueError:
            j = {"success": False, "compiler_out": p.stdout, "compiler_err": p.stderr}
        log = (j.get("compiler_out") or "") + (j.get("compiler_err") or "")
        if j.get("error"):
            log += ("\n" if log else "") + str(j["error"])
        roots = [(sk, ""), (data / "board", "board")]
        msgs = parse_messages(log, roots)
        for m in msgs:
            if m["file"] == stem + ".ino":
                m["file"] = main
        for prefix in (str(sk) + os.sep, str(sk) + "/"):
            log = log.replace(prefix + stem + ".ino", main).replace(prefix, "")
        sizes = {s.get("name"): s for s in ((j.get("builder_result") or {}).get("executable_sections_size") or [])}
        size = None
        if "text" in sizes:
            size = {"flash": sizes["text"].get("size"), "flashMax": sizes["text"].get("max_size"),
                    "ram": (sizes.get("data") or {}).get("size"), "ramMax": (sizes.get("data") or {}).get("max_size")}
        ok = bool(j.get("success")) and p.returncode == 0
        b = bin_dir / (stem + ".ino.bin")
        if ok and not b.is_file():
            ok = False
            msgs.append({"file": None, "line": None, "col": None, "severity": "error", "text": "The build passed but made no .bin."})
        if not ok and not any(m["severity"] == "error" for m in msgs):
            msgs.append({"file": None, "line": None, "col": None, "severity": "error",
                         "text": (str(j.get("error") or "").strip() or "The build failed; see the log.")[:500]})
        extra = {}
        if ok:
            data_bytes = b.read_bytes()
            (out_dir / (commit + ".bin")).write_bytes(data_bytes)
            extra = {"sha256": hashlib.sha256(data_bytes).hexdigest(), "bytes": len(data_bytes)}
        return finish(ok=ok, size=size, messages=msgs, log=trim(log), main=main, **extra)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--commit", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cli", default=os.environ.get("ARDUINO_CLI", "arduino-cli"))
    ap.add_argument("--build-cache")
    a = ap.parse_args()
    if not ID_RE.match(a.project) or not SHA_RE.match(a.commit):
        sys.exit("bad project id or commit")
    r = build(a.data, a.project, a.commit, a.out, a.cli, a.build_cache)
    print("%s %s: %s in %.1f s%s" % (a.project, a.commit[:8], "passed" if r["ok"] else "failed", r["seconds"],
                                     "" if r["ok"] else " (%d messages)" % len(r["messages"])))


if __name__ == "__main__":
    main()
