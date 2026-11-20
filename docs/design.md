# Jig: design

Jig is an online editor and compiler for Arduino-style firmware on Dovetail boards. An engineer picks a
board, edits a sketch in the browser, presses **Build**, and flashes the result with Flasher, without
installing the Arduino IDE. It's a separate tool so it can grow into a general online editor without
becoming part of the suite yet (Chris, 2026-11-19).

Status: **proposed** (2026-11-19). Nothing here is agreed until Chris says so.

## Decisions so far (Chris, 2026-11-19)

| Question | Answer |
| --- | --- |
| How does it compile? | **GitHub Actions**, in the private data repo. No compile server. |
| Its own tool, or a tab in Flasher? | **Its own tool and repos**, so it's developed on its own. |
| Name | **Jig** (a woodworking fixture for making parts the same way every time). |

## Why the build can't be in the page

Measured on Chris's laptop (2026-11-19) with Dovetail's first board package:

| | |
| --- | --- |
| The Dovetail board package | 0.2 MB |
| ST's STM32duino core 3.0.0, its tools, and arm-gcc | 2.9 GB |
| The core compiled for one board setup | about 0.7 MB |
| A larger example, first build | 78 s |
| The same build again in the IDE, nothing changed | 17 s |
| Jig's `tools/build.py`, first build | 55 s |
| Jig's `tools/build.py`, cached (core and libraries kept, new sketch) | 31 to 39 s |

A static page can't hold a 2.9 GB toolchain, and a Cloudflare Worker can't run gcc. GitHub Actions can,
and it fits the suite as it is: static pages, private repos, and Sign in with GitHub.

## Repos

| Repo | Visibility | What's in it |
| --- | --- | --- |
| `jig` | public | The pages, the build script the workflow runs, and a template of the workflow. **No board code, sketches, or builds**: the page reads them from `jig_data` once someone signs in. Served by GitHub Pages. |
| `jig_data` | private, **Actions on** | The board package copied in at a pinned commit, the boards list, every sketch, every build, and the workflow. |

`flasher_data` is untouched and keeps Actions off.

### `jig_data` layout

```
board/
  hardware/dovetail/stm32/...      the board package, copied by tools/sync_data.py
  SOURCE.json                      { repo, commit, copiedAt, copiedBy } of that copy
boards.json                        the boards Jig can build for (below)
projects/<id>/project.json         { name, board, createdAt, createdBy, updatedAt, updatedBy, flasher? }
projects/<id>/sketch/<file>        the sketch: one <Name>.ino and any .h, .c, or .cpp beside it
builds/<id>/<commit>.json          a build's result (below)
builds/<id>/<commit>.bin           the firmware, when the build passed
.github/workflows/build.yml        the build (copied from jig/tools/workflow/build.yml)
tools/build.py                     the build script (copied from jig/tools/build.py)
```

`boards.json`:

```json
{
  "format": "jig.boards/1",
  "core": { "id": "STMicroelectronics:stm32", "version": "3.0.0",
            "index": "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json" },
  "boards": {
    "my-board": { "name": "My Board", "fqbn": "dovetail:stm32:my_board", "flasher": "<Flasher board id>",
                  "examples": "board/hardware/dovetail/stm32/libraries/MyBoard/examples" }
  }
}
```

A project's id is its name's slug and 4 random characters, as Signoff's standards sections are made.

## Building

1. **Save** commits the project's changed files in one commit (`GitHubStore.putFiles`, `force: false`,
   on the head the page read). The commit's sha names the build.
2. The workflow runs on a push that touches `projects/**`. It works out which projects changed between the
   push's before and after commits, and builds each.
3. **The build job** has `permissions: contents: read`, checks out with `persist-credentials: false`, and
   holds no secrets. A sketch can `#include` any file on the runner, so nothing worth stealing is there.
   It installs `arduino-cli` and the core named in `boards.json`, cached by core version, and keeps the
   compiled core in a cache keyed by board, core version, and board package commit (about 55 s down to 31 to 39 s on Chris's Windows laptop; Linux in Actions is untimed until the trial build).
   It runs `tools/build.py`, which compiles with `arduino-cli compile --json` and writes the result.
   It hands the results on as a workflow artifact.
4. **The publish job** has `permissions: contents: write` and uses only the workflow's own `GITHUB_TOKEN`.
   It commits `builds/<id>/<commit>.json` and `.bin`, and retries on a race. Its commit touches only
   `builds/`, and a push made with `GITHUB_TOKEN` starts no workflow, so builds never loop.
5. The page checks `builds/<id>/<commit>.json` every 5 s (the contents API with the user's own sign-in, so
   the app needs no Actions permission), shows the elapsed time, and after 10 minutes stops and links to the
   repo's Actions page.

A failed build still writes its `.json`, so the page always learns the result. If the build job itself
crashes (a broken workflow, a full disk), the publish job writes a `.json` saying so.

### A build's result

```json
{
  "format": "jig.build/1",
  "project": "<id>", "commit": "<sha>", "board": "my-board", "fqbn": "dovetail:stm32:my_board",
  "core": "STMicroelectronics:stm32@3.0.0", "boardPackage": { "repo": "Dovetail-PD/Arduino", "commit": "<sha>" },
  "ok": true, "startedAt": "…", "seconds": 21.4,
  "size": { "flash": 31144, "flashMax": 524288, "ram": 4210, "ramMax": 114688 },
  "sha256": "<of the .bin>",
  "messages": [{ "file": "Blink.ino", "line": 12, "col": 5, "severity": "error", "text": "'ledPin' was not declared in this scope" }],
  "log": "the compiler's output, trimmed to 64 KB"
}
```

`messages` are parsed from gcc's `file:line:col: severity: text` lines. A sketch file is named by its name
alone; anything else keeps its path below the board package or the core.

## The board package

`tools/sync_data.py` copies a package's `hardware/` folder (`--package <folder>`) from a checkout of `Dovetail-PD/Arduino` into
`jig_data/board/`, the way the suite vendors engine files:

- It reads from a clean checkout at one commit and refuses a commit older than `c5e2d77` (the USB detach
  every build must keep; `Arduino/CLAUDE.md`).
- It also writes `boards.json` (from the package's `flasher.json` and the FQBN in its `tools/build.sh`, with
  the core pinned by `--core`), and copies `tools/build.py` and the workflow (`tools/workflow/build.yml`) in,
  so the repo always builds with this repo's script. It never touches `projects/` or `builds/`.
- It dry-runs first: the files that change, and the commit they come from. `--confirm <code>` commits them
  with `SOURCE.json` in one commit on the head it read (`force: false`), then reads back.
- So a library change reaches Jig only when someone runs it. Builds record the board package commit they
  used.

Copying it in means the workflow never needs a token for the private Arduino repo.

## The page

One page, `jig/index.html`, laid out like the other tools (sidebar, toolbar, sidebar foot, Sign in with
GitHub from the hub's `auth.js` and `sidefoot.js`, the suite's theme).

- **Sidebar:** the projects in `jig_data`, newest first, with their board and last build's state. **+ New
  project** asks a name and a board, and starts from the board's starter example or any example.
- **Editor:** tabs for the sketch's files. Version 1 is Jig's own small editor: a text box with line
  numbers, C++ highlighting, Tab indents, and marks on the lines the last build flagged. The pages allow only
  their own scripts, so CodeMirror would have to be bundled and copied in; it can replace the editor later
  without changing anything else.
- **Toolbar:** **Save and build** (Ctrl+S: saves, which starts the build, then waits for the result), **.bin**
  (downloads a passing build, checked against its `sha256`), and a **Flasher** link. Unsaved edits
  stay in the browser (IndexedDB) until saved, so a reload loses nothing.
- **Build panel** under the editor: waiting, then passed (flash and RAM use against the board's) or failed
  (each message, a click goes to its line), and the full log folded.
- **Flashing:** for now, download the `.bin` and flash it from Flasher's Serial bootloader tab as a file. Phase 2
  makes it a **Flash** button that opens Flasher in the same tab on that build (see *Flasher*).
- **Who:** anyone who can open `jig_data`. For now that's FTEs only (Chris adds them as collaborators).
  Sharing a project with a client or contractor comes later, if ever.
- **Demo** (`?demo`): the Smart Thermostat's Main PCBA (made up), two sketches kept in the browser, and a
  simulated build: about 3 s, then passed, or failed with the line of any `#error` or unbalanced brace.

## Flasher (phase 2)

- **From Jig:** a section in Flasher's sidebar, beside Working projects and Released projects, listing Jig
  projects with a passing build. Flasher reads `jig_data` with the user's sign-in and flashes the `.bin` it
  finds, checking `sha256`. Jig's **Flash** opens `../flasher/?jig=<project>/<commit>`.
- **New editable project…** on a Flasher project opens `../jig/?new=1&board=<Flasher board id>`, with the
  board picked.
- **Save as image** in Flasher copies a Jig build into a Working project as an uploaded image (`kind:
  "file"`), with `source: { tool: "jig", project, commit }`.

Flasher reads `jig_data`; Jig never writes `flasher_data`.

## Order of work

1. This doc, agreed.
2. **Built locally (2026-11-19):** `tools/build.py`, tried against the real board package; the
   workflow file; `tools/sync_data.py` (its local half checked; never run against GitHub, since no repo exists yet); the page and its demo.
3. **Done 2026-11-19:** `jig` (public) and `jig_data` (private) created at Chris's OK; Actions is on in `jig_data`.
   Pages on `jig` comes after the first push (Chris).
4. **Done 2026-11-20:** the board package, `boards.json`, the build script, and the workflow committed (`jig_data`
   `50019ee7`), and a Blink trial built in Actions in 2 min cold (core install 44 s, compile 33 s). As planned:
   the board package copied in (dry run, Chris's OK), `boards.json`, and the workflow committed. GitHub refuses a
   push that creates or changes a workflow file unless the token has the `workflow` scope (classic) or
   Workflows: write (fine-grained); if Chris's token hasn't, he commits `.github/workflows/build.yml` himself the
   first time, and later changes to it go the same way. One trial
   build of a board example, to time a first and a cached build on Linux.
5. The page signed in: a real project, Save, Build, the result, and the `.bin` flashed through Flasher.
6. Phase 2: the Flasher links.

## Rules

- **No client data in `jig`.** Sketches and builds are client work: they live only in `jig_data`. Grep
  before every push, as in the rest of the suite.
- **No secrets in the build job.** Only the publish job writes, and only with `GITHUB_TOKEN`.
- **Pinned toolchain.** Core version in `boards.json`; board package commit in `board/SOURCE.json`; both
  recorded in every build.
- **American English, metric, and the serial comma** in UI text, docs, and commit messages.

## Open questions

- Should a project be able to pin an older board package commit (to rebuild an old firmware exactly)? Not in
  version 1: every build uses the current copy and records it.
- Libraries beyond the board package (an Arduino library from the Library Manager): not in version 1.
- Actions minutes: a private repo on the free plan has 2,000 minutes a month; a cached build is likely
  under a minute. Measure in step 4.
