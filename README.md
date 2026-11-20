# Jig

An online editor for Arduino-style firmware on Dovetail boards. Pick a board, edit a sketch in the browser,
and **Save and build**: the sketch is committed to the private `jig_data` repo, whose GitHub Actions compile it
with `arduino-cli`. The page shows the result (errors on their lines, flash and RAM use), and a passing
build's `.bin` flashes from Flasher.

A prototype in the Dovetail Signoff suite, kept apart from the rest (no hub link yet). Design and decisions:
`docs/design.md`.

- `index.html`, `assets/`: the page. `editor.js` (the editor), `store.js` (jig_data, or this browser in the
  demo), `demo.js` (the made-up Smart Thermostat board and a simulated build), `app.js`.
- `tools/build.py`: builds one project and writes its result; the workflow runs it.
- `tools/workflow/build.yml`: the workflow, copied into `jig_data` as `.github/workflows/build.yml`.
- `tools/sync_data.py`: copies the board package, `boards.json`, the build script, and the workflow into
  `jig_data` (dry run, then `--confirm`).
- `?demo`: projects in this browser and a simulated build, no sign-in.

Tests: serve the tools folder and open `tests/test.html` (title PASS), and `python tests/test_build.py`.

No license chosen yet.
