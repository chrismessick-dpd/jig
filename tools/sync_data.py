"""Copy what Jig's builds need into the private jig_data repo, as one commit (docs/design.md, *The board package*).

    python tools/sync_data.py --package <folder>                    # dry run: what would change
    python tools/sync_data.py --package <folder> --confirm <code>   # commit exactly that change, then read it back

It copies, from a clean checkout of the Arduino repo at its HEAD (--arduino, default C:/Dovetail/Arduino):
  - the board package (<package>/hardware, git-tracked files only) to board/hardware/, removing files gone
    from it, and board/SOURCE.json naming the commit;
  - boards.json, made from the package's flasher.json and tools/build.sh (the board's FQBN), with the core
    pinned by --core;
and, from this repo, tools/build.py, tools/trim_core.py, and tools/workflow/build.yml (as .github/workflows/build.yml).
Nothing else in jig_data is touched: projects/ and builds/ never appear in the change.

It refuses a checkout with uncommitted changes under the package, or older than the USB detach fix
(c5e2d77, Arduino/CLAUDE.md). The token is ../ee_tools_token.txt (or JIG_TOKEN), never printed. The commit
is made on the head the dry run read (force: false), so a repo that moved on in between is refused.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT.parent / "ee_tools_token.txt"
API = "https://api.github.com"
DETACH_FIX = "c5e2d77"
CORE_INDEX = "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json"


def token():
    t = os.environ.get("JIG_TOKEN", "").strip()
    if not t and TOKEN_FILE.exists():
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not t:
        sys.exit("No token: put one in ../ee_tools_token.txt or JIG_TOKEN")
    return t


def api(path, method="GET", body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token(), "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jig-sync"})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit("GitHub %s %s: %s %s" % (method, path, e.code, e.read()[:300].decode("utf-8", "replace")))


def git(repo, *args, binary=False):
    p = subprocess.run(["git", "-C", str(repo)] + list(args), capture_output=True)
    if p.returncode:
        raise RuntimeError("git %s: %s" % (" ".join(args), p.stderr.decode("utf-8", "replace").strip()))
    return p.stdout if binary else p.stdout.decode("utf-8")


def blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def wanted(arduino, package, core):
    """{ path in jig_data: bytes } for everything this script owns, and the source commit."""
    pkg = package.rstrip("/")
    dirty = git(arduino, "status", "--porcelain", "--", pkg + "/hardware").strip()
    if dirty:
        sys.exit("The board package has uncommitted changes; commit or stash them first:\n" + dirty)
    head = git(arduino, "rev-parse", "HEAD").strip()
    try:
        git(arduino, "merge-base", "--is-ancestor", DETACH_FIX, head)
    except RuntimeError:
        sys.exit("HEAD %s is older than %s, the USB detach fix every build must keep." % (head[:8], DETACH_FIX))
    remote = git(arduino, "remote", "get-url", "origin").strip()
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", remote)
    out = {}
    for f in git(arduino, "ls-files", "-z", "--", pkg + "/hardware").split("\0"):
        if f:
            out["board/" + f[len(pkg) + 1:]] = git(arduino, "show", "HEAD:" + f, binary=True)
    fl = json.loads(git(arduino, "show", "HEAD:" + pkg + "/flasher.json"))
    build_sh = git(arduino, "show", "HEAD:" + pkg + "/tools/build.sh")
    fq = re.search(r'FQBN="\$\{FQBN:-([^}]+)\}"', build_sh)
    if not fq:
        sys.exit("Couldn't find the default FQBN in tools/build.sh")
    b = fl["board"]
    core_id, core_ver = core.split("@")
    boards = {"format": "jig.boards/1", "core": {"id": core_id, "version": core_ver, "index": CORE_INDEX},
              "boards": {b["id"]: {"name": b["name"], "fqbn": fq.group(1), "flasher": b["id"],
                                   "examples": "board/" + fl["examples"]}}}
    out["boards.json"] = (json.dumps(boards, indent=2) + "\n").encode()
    out["tools/build.py"] = (ROOT / "tools" / "build.py").read_bytes()
    out["tools/trim_core.py"] = (ROOT / "tools" / "trim_core.py").read_bytes()
    out[".github/workflows/build.yml"] = (ROOT / "tools" / "workflow" / "build.yml").read_bytes()
    source = {"repo": m.group(1) if m else remote, "commit": head, "package": pkg}
    return out, source


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arduino", default="C:/Dovetail/Arduino")
    ap.add_argument("--package", required=True, help="the board package's folder in the Arduino repo")
    ap.add_argument("--repo", default="chrismessick-dpd/jig_data")
    ap.add_argument("--core", default="STMicroelectronics:stm32@3.0.0")
    ap.add_argument("--confirm")
    a = ap.parse_args()

    want, source = wanted(pathlib.Path(a.arduino), a.package, a.core)
    head = api("/repos/%s/git/ref/heads/main" % a.repo)["object"]["sha"]
    tree_sha = api("/repos/%s/git/commits/%s" % (a.repo, head))["tree"]["sha"]
    tree = api("/repos/%s/git/trees/%s?recursive=1" % (a.repo, tree_sha))
    if tree.get("truncated"):
        sys.exit("The repo's tree is too big to read in one call")
    have = {e["path"]: e["sha"] for e in tree["tree"] if e["type"] == "blob"}

    # SOURCE.json changes only when the commit does, so a re-run with nothing new commits nothing.
    old_src = None
    if "board/SOURCE.json" in have:
        old_src = json.loads(base64.b64decode(api("/repos/%s/git/blobs/%s" % (a.repo, have["board/SOURCE.json"]))["content"]))
    if not old_src or old_src.get("commit") != source["commit"] or old_src.get("repo") != source["repo"]:
        source["copiedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        want["board/SOURCE.json"] = (json.dumps(source, indent=2) + "\n").encode()
    else:
        want["board/SOURCE.json"] = None   # unchanged

    changes = []
    for path in sorted(want):
        data = want[path]
        if data is None:
            continue
        sha = blob_sha(data)
        if have.get(path) != sha:
            changes.append(("add" if path not in have else "change", path, data, sha))
    for path in sorted(have):
        if path.startswith("board/hardware/") and path not in want:
            changes.append(("remove", path, None, None))
    for p in [c[1] for c in changes]:
        if p.startswith(("projects/", "builds/")):
            sys.exit("Refusing: the change would touch " + p)

    print("%s at %s; board package from %s %s" % (a.repo, head[:8], source["repo"], source["commit"][:8]))
    if not changes:
        print("Nothing to change.")
        return
    for kind, path, data, _ in changes:
        print("  %-6s %s%s" % (kind, path, "" if data is None else " (%d bytes)" % len(data)))
    # The code covers what the dry run showed, not the clock: SOURCE.json counts without its copiedAt stamp.
    def code_sha(p, s):
        if p != "board/SOURCE.json" or s is None:
            return s
        return blob_sha((json.dumps({k: v for k, v in source.items() if k != "copiedAt"}, indent=2) + "\n").encode())
    code = hashlib.sha256((head + "".join("%s %s %s\n" % (k, p, code_sha(p, s)) for k, p, _, s in changes)).encode()).hexdigest()[:6]
    if a.confirm != code:
        print("\nDry run. To commit exactly this on %s, run again with --confirm %s" % (head[:8], code))
        return

    entries = []
    for kind, path, data, sha in changes:
        if kind == "remove":
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
        else:
            b = api("/repos/%s/git/blobs" % a.repo, "POST", {"content": base64.b64encode(data).decode(), "encoding": "base64"})
            if b["sha"] != sha:
                sys.exit("GitHub stored %s with another checksum" % path)
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": sha})
    new_tree = api("/repos/%s/git/trees" % a.repo, "POST", {"base_tree": tree_sha, "tree": entries})
    msg = "Jig: board package from %s %s, build script, and workflow" % (source["repo"], source["commit"][:8])
    commit = api("/repos/%s/git/commits" % a.repo, "POST", {"message": msg, "tree": new_tree["sha"], "parents": [head]})
    api("/repos/%s/git/refs/heads/main" % a.repo, "PATCH", {"sha": commit["sha"], "force": False})

    # Read back: every path we own is as wanted, and nothing else moved.
    back = api("/repos/%s/git/trees/%s?recursive=1" % (a.repo, new_tree["sha"]))
    got = {e["path"]: e["sha"] for e in back["tree"] if e["type"] == "blob"}
    expect = dict(have)
    for kind, path, _, sha in changes:
        if kind == "remove":
            expect.pop(path, None)
        else:
            expect[path] = sha
    if got != expect:
        sys.exit("Read back differs from what was meant! Check %s at %s" % (a.repo, commit["sha"]))
    print("Committed %s (%d files) and read back." % (commit["sha"][:8], len(changes)))


if __name__ == "__main__":
    main()
