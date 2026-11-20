# Jig (jig): notes for Claude

Jig is an online editor and compiler for Arduino-style firmware: the page edits sketches, the private
`jig_data` repo's GitHub Actions builds them, and Flasher flashes the result. Read `docs/design.md` first, and
`../CLAUDE.md` for the suite's hard rules.

## Status (2026-11-19)

- **Proposed and built locally.** Chris chose GitHub Actions over a compile server, a separate tool over a tab in
  Flasher (so it's developed on its own and stays out of the mainstream), and the name Jig. `docs/design.md` is
  waiting for his OK.
- **Repos created 2026-11-19 at Chris's OK:** `chrismessick-dpd/jig` (public, empty; the local folder isn't a git
  repo yet) and `chrismessick-dpd/jig_data` (private, `main` with GitHub's README; Actions already on). Pages on
  `jig` waits for the first push, and Chris turns it on.
- Built: the page and its demo, `tools/build.py` (run locally against the real board package: two examples
  passed with byte-for-byte the IDE's `.bin`, and a broken sketch failed with its line), the workflow, and
  `tools/sync_data.py` (its local half checked; never run against GitHub).
- Measured on Chris's laptop: a cold build 55 to 78 s, a cached one 31 to 39 s (one fixed sketch folder, so
  arduino-cli keeps the compiled core). Linux in Actions is untried.
- Not linked from the hub or any tool. Flasher's side (a *From Jig* section, `?jig=`, New editable project) is
  phase 2.

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
