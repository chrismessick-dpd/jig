# Jig (jig): notes for Claude

Jig is an online editor and compiler for Arduino-style firmware: the page edits sketches, the private
`jig_data` repo's GitHub Actions builds them, and Flasher flashes the result. Read `docs/design.md` first, and
`../CLAUDE.md` for the suite's hard rules.

## Status (2026-11-19)

- **Proposed and built locally.** Chris chose GitHub Actions over a compile server, a separate tool over a tab in
  Flasher (so it's developed on its own and stays out of the mainstream), and the name Jig. `docs/design.md` is
  waiting for his OK.
- **Repos created 2026-11-19 at Chris's OK:** `chrismessick-dpd/jig` (public; first push `73e3035`, at Chris's OK) and `chrismessick-dpd/jig_data` (private, `main` with GitHub's README; Actions already on). Pages on
  `jig` is Chris's to turn on.
- Built: the page and its demo, `tools/build.py` (run locally against the real board package: two examples
  passed with byte-for-byte the IDE's `.bin`, and a broken sketch failed with its line), the workflow, and
  `tools/sync_data.py` (its local half checked; never run against GitHub).
- Measured on Chris's laptop: a cold build 55 to 78 s, a cached one 31 to 39 s (one fixed sketch folder, so
  arduino-cli keeps the compiled core). In Actions (2026-11-20, the first build, Blink): 2 min end to end, of which
  installing the core took 44 s and compiling 33 s. A cached run (Chris's second build, 03:26
  UTC): 84 s, of which restoring the core from the cache took 32 s, installing it 2 s, and compiling 23 s. The core
  cache barely beats a fresh install (32 s vs. 44 s); slimming what's cached is the next speed-up.
- **Trial build passed:** `jig_data` `50019ee7` (board package, build script, workflow; synced at Chris's OK),
  then "Blink trial" made in hosted Jig signed in (`beb74e08`), built and published by Actions (`f4d79d90`). Not
  yet flashed on a board; its `.bin` differs from the Windows build's from the vector table on (same strings).
- **Flash into Flasher (2026-11-20, Chris: "start integrating to pass over to flasher"):** Jig's **Flash** (a passing
  build, no unsaved edits) checks the `.bin` against its record's SHA-256, leaves it in IndexedDB `dovetail-handoff`
  (the engine's `Signoff.handoff`, `-demo` in the demo; id `jig:<project>/<commit>`, with the Flasher board from
  `boards.json`'s `flasher`), and opens `../flasher/?jig=<project>/<commit>`. Flasher (`flasher/assets/jig.js`) takes
  it, or reads `jig_data` when it isn't there, checks the SHA-256 again, and opens it as a file for that board with a
  *From Jig* note. The demo board maps to Flasher's `tstat-main`, and the demo `.bin` has a real vector table.
  Tried in both demos: built, Flash, the simulated board written, read back, and running. Not tried signed in.
- **Wider indent (2026-11-20, Chris: hard to see the structure):** every space is drawn half a character wider
  (`word-spacing` on the text box and its copy alike, so they stay aligned: checked to the pixel), so a 2-space
  indent is 3 characters wide, with faint guides on the leading spaces (`.jg-ind`). Files are unchanged.
- **From Flasher (2026-11-20):** Flasher's sidebar lists each Jig project's newest passing build (*From Jig*), and its
  Working projects' boards offer **New editable project…**, opening `?new=1&board=<Flasher board id>` (Jig maps it
  through `boards.json`'s `flasher` and clears the address after). Sign out from Jig (the hub's `sidefoot.js`) deletes
  `jig-local` and `jig-local-demo`; EE's own list (`SUITE_DBS` in its `app.js`) still needs them, held back because
  another session had EE's `app.js` open (2026-11-20).
- **Build progress (2026-11-20, Chris: "live link and steps"):** while a build runs, the panel shows four stages
  (waiting for GitHub, the board's tools, compiling, saving the result) with each one's time and the last build's
  total, from GitHub's Actions API (`store.progress`, `JIG.store.stagesFrom`, matched to the workflow's job and step
  names: rename a step in `tools/workflow/build.yml` and the mapping goes with it), and a **Watch the log on GitHub ↗**
  link to the run (GitHub streams it live). The steps need **Actions: Read** on the sign-in GitHub App; without it the
  API answers 403 and only the link shows. Chris added the permission and accepted it on the installation (2026-11-20);
  checked from the hosted page signed in: runs and jobs read (200). The demo simulates the stages.
- Not linked from the hub.

## Rules

- **No client data in this repo.** No board names, sketches, builds, or real board packages: they live only in
  `jig_data`. `boards.json` is written by `sync_data.py` from the Arduino repo, never from here. Grep for the
  suite's client terms (`../CLAUDE.md`) before a commit.
- **The build job holds no secrets.** Only the publish job writes, with the workflow's own `GITHUB_TOKEN`. Keep
  it that way in `tools/workflow/build.yml`.
- **Every build records its toolchain:** the core version (`boards.json`) and the board package commit
  (`board/SOURCE.json`). `sync_data.py` refuses a board package older than `c5e2d77` (`Arduino/CLAUDE.md`).
- **Writes to `jig_data`** from the command line go through `sync_data.py`: dry run, `--confirm`, `force: false`
  on the head it read, read back. Show Chris the dry run first.
- **Severity never by hue alone** (Chris is colorblind): errors ✕ with `--issue-hatch`, warnings ▲ with
  `--warn-hatch`.
- **American English, metric, and the serial comma** in UI text, docs, and commit messages.
- `assets/suite.css` and `assets/vendor/` are copies (`tools/sync_suite_css.py`, `tools/sync_vendor.py`); never
  edit them. The sign-in and sidebar foot load from `../signoff/assets/`.
- **Commit and push only when Chris asks.**

## Before finishing a change

1. `python tools/stamp_version.py`.
2. Serve the tools folder (preview `signoff-suite-alt`, port 8774, or `signoff-suite`, 8771) and open
   `jig/tests/test.html`: PASS (13 tests). `python tests/test_build.py` (7).
3. `jig/index.html?demo`: open *Room temperature*, Save and build: it fails on line 15 (a missing semicolon,
   on purpose); add the `;`, build again, and it passes with flash and RAM bars.
