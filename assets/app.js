// Jig: edit a sketch for a Dovetail board, save it to jig_data, and let that repo's GitHub Actions build it
// (docs/design.md). The page never compiles; it saves, waits for builds/<id>/<commit>.json, and shows it.
(function (JIG) {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DEMO = /[?&]demo\b/.test(location.search);
  JIG.DEMO = DEMO;
  const DATA = { owner: 'chrismessick-dpd', repo: 'jig_data' };
  const POLL_MS = DEMO ? 800 : 5000, WAIT_MAX = 10 * 60000;

  const state = {
    store: null, index: null, error: '', loading: false,
    cur: null,          // { id, meta, files, shas, file, dirty, build: { commit, result } }
    wait: null,         // { id, commit, t0 } while a build is awaited
    logOpen: false
  };
  const drafts = JIG.store.kv(DEMO);
  let ed = null;

  // ── Theme and sidebar: the suite's keys ──
  const SETTINGS_KEY = 'signoff.v1.settings';
  const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function readTheme() { try { return (JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}).theme || 'auto'; } catch (e) { return 'auto'; } }
  function writeTheme(t) { try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; s.theme = t; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* blocked */ } }
  const isDark = t => t === 'dark' || (t !== 'light' && !!(darkQuery && darkQuery.matches));
  const ICON = {
    sun: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3"/></svg>',
    moon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M16 12.3A6.5 6.5 0 0 1 7.7 4a6.5 6.5 0 1 0 8.3 8.3z"/></svg>',
    code: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l-3 4 3 4M14 6l3 4-3 4M11.5 4.5l-3 11"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>',
    bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5 4 9h4l-1 5.5L12 7H8z"/></svg>'
  };
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const b = $('#theme-btn');
    if (b) { b.innerHTML = isDark(t) ? ICON.sun : ICON.moon; b.title = isDark(t) ? 'Light mode' : 'Dark mode'; }
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => applyTheme(readTheme()));
  const SIDE_KEY = (DEMO ? 'jig.demo.' : 'jig.v1.') + 'sideCollapsed';
  const narrow = window.matchMedia ? matchMedia('(max-width: 860px)') : { matches: false };
  function toggleSidebar() {
    if (narrow.matches) { $('#app').classList.toggle('nav-open'); return; }
    const on = !$('#app').classList.contains('side-collapsed');
    $('#app').classList.toggle('side-collapsed', on);
    try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch (e) { /* blocked */ }
  }
  document.addEventListener('click', e => {
    const app = $('#app');
    if (!app.classList.contains('nav-open') || e.target !== app) return;
    app.classList.remove('nav-open'); e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.sheet-wrap')) return;
    e.preventDefault(); toggleSidebar();
  });

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' jg-toast-error' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3600);
  }
  const who = () => { const w = window.SignoffFoot ? window.SignoffFoot.who() : {}; return w.login ? '@' + w.login : (DEMO ? 'demo visitor' : ''); };
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  const kb = n => n == null ? '' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  const boardName = id => { const b = state.index && state.index.boards[id]; return b ? b.name : id || 'No board'; };
  const mainFile = cur => cur.meta.main && cur.files[cur.meta.main] != null ? cur.meta.main : Object.keys(cur.files).sort().find(n => n.endsWith('.ino'));

  // ── Starting the store ──
  async function start() {
    state.error = ''; state.index = null; state.cur = null; ed = null;
    if (DEMO) state.store = JIG.store.DemoJig();
    else {
      const w = window.SignoffFoot ? window.SignoffFoot.who() : {};
      state.store = w.token ? JIG.store.GitHubJig(Object.assign({ token: w.token, who: w.login ? '@' + w.login : '' }, DATA)) : null;
    }
    renderAll();
    if (!state.store) return;
    state.loading = true; renderAll();
    try { state.index = await state.store.open(); }
    catch (e) {
      state.error = e.status === 404 ? 'Jig\'s data repo, ' + DATA.owner + '/' + DATA.repo + ', isn\'t there or your sign-in can\'t open it. Jig is for FTEs; ask Chris to add you.' : (e.message || String(e));
    }
    state.loading = false;
    renderAll();
    openLink();
  }
  async function refreshIndex() {
    try { state.index = await state.store.open(); renderSide(); } catch (e) { /* keep the list we have */ }
  }

  // ── Links: ?project=<id>, ?new=1&board=<Jig or Flasher board id> ──
  function openLink() {
    if (!state.index) return;
    const q = new URLSearchParams(location.search);
    if (q.get('project')) openProject(q.get('project'));
    else if (q.get('new')) {
      const want = q.get('board') || '', bs = state.index.boards;
      const id = bs[want] ? want : Object.keys(bs).find(k => bs[k].flasher === want);
      newProject(id);
    }
  }
  function setLink(id) {
    const q = new URLSearchParams(location.search);
    q.delete('new'); q.delete('board');
    if (id) q.set('project', id); else q.delete('project');
    const s = q.toString().replace(/demo=(&|$)/, 'demo$1');
    history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
  }

  // ── Projects ──
  async function openProject(id) {
    if (state.cur && state.cur.id === id) return;
    if (state.cur && state.cur.dirty) await keepDraft();
    state.cur = { id, loading: true, meta: { name: '' }, files: {} };
    state.logOpen = false; ed = null;
    setLink(id); renderAll();
    try {
      const p = await state.store.load(id);
      const d = await drafts.get(id);
      const cur = { id, meta: p.meta, files: p.files, shas: p.shas, build: p.build, dirty: false };
      if (d && d.files && JSON.stringify(d.files) !== JSON.stringify(p.files)) {
        cur.files = d.files; cur.dirty = true;
        if (JSON.stringify(d.shas) !== JSON.stringify(p.shas)) cur.stale = true;   // saved elsewhere since the draft began
        toast('Your unsaved edits are back' + (cur.stale ? ', but someone has saved this project since you made them' : ''));
      }
      cur.shas = d && cur.dirty ? d.shas : p.shas;
      cur.file = mainFile(cur) || Object.keys(cur.files)[0] || null;
      if (state.cur && state.cur.id === id) state.cur = cur;
      if (cur.build && !cur.build.result) wait(id, cur.build.commit, Date.now());
    } catch (e) {
      state.cur = null; toast(e.message || String(e), 'error'); setLink(null);
    }
    if ($('#app').classList.contains('nav-open')) $('#app').classList.remove('nav-open');
    renderAll();
  }

  function keepDraft() {
    const c = state.cur;
    if (!c || !c.dirty) return Promise.resolve();
    return drafts.put(c.id, { files: c.files, shas: c.shas, at: new Date().toISOString() });
  }
  let draftTimer = null;
  function edited(text) {
    const c = state.cur;
    if (!c || !c.file) return;
    c.files[c.file] = text;
    if (!c.dirty) { c.dirty = true; renderToolbar(); renderSide(); renderTabs(); }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(keepDraft, 400);
  }

  async function save(force) {
    const c = state.cur;
    if (!c || c.loading || c.saving) return;
    const main = mainFile(c);
    if (!main) { toast('A sketch needs one .ino file', 'error'); return; }
    c.saving = true; renderToolbar();
    try {
      const meta = Object.assign({}, c.meta, { updatedBy: who() });
      const r = await state.store.save(c.id, meta, c.files, force ? null : c.shas);
      c.saving = false; c.dirty = false; c.stale = false;
      c.shas = await state.store.shasOf(c.files);
      await drafts.del(c.id);
      if (!r.commit) {
        toast(c.build ? 'Nothing changed since the last save' : 'Nothing to save');
      } else {
        c.build = { commit: r.commit, result: null };
        wait(c.id, r.commit, Date.now());
      }
      refreshIndex();
    } catch (e) {
      c.saving = false;
      if (e.code === 'conflict') conflictSheet();
      else toast('Couldn\'t save: ' + (e.message || e), 'error');
    }
    renderAll();
  }

  // ── Waiting for a build ──
  let pollTimer = null, tickTimer = null;
  function wait(id, commit, t0) {
    state.wait = { id, commit, t0 };
    clearTimeout(pollTimer); clearInterval(tickTimer);
    tickTimer = setInterval(renderBuild, 1000);
    poll();
  }
  async function poll() {
    const w = state.wait;
    if (!w) return;
    let r = null;
    try { r = await state.store.result(w.id, w.commit); } catch (e) { /* try again */ }
    if (state.wait !== w) return;
    if (r) {
      state.wait = null; clearInterval(tickTimer);
      const c = state.cur;
      if (c && c.id === w.id && c.build && c.build.commit === w.commit) { c.build.result = r; showMarks(); }
      if (!c || c.id !== w.id) toast('The build of ' + (r.name || w.id) + (r.ok ? ' passed' : ' failed'));
      else if (!r.ok) state.logOpen = false;
      renderAll();
      return;
    }
    if (Date.now() - w.t0 > WAIT_MAX) { state.wait = Object.assign({}, w, { gaveUp: true }); clearInterval(tickTimer); renderBuild(); return; }
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function showMarks() {
    if (!ed || !state.cur) return;
    const r = state.cur.build && state.cur.build.result;
    ed.marks(r ? (r.messages || []).filter(m => m.file === state.cur.file && m.line) : []);
  }

  // The passing build's bytes, checked against its record's SHA-256.
  async function buildBytes() {
    const c = state.cur, r = c && c.build && c.build.result;
    if (!r || !r.ok) throw new Error('No passing build to use');
    const bytes = await state.store.binary(c.id, c.build.commit);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
    if (r.sha256 && hex !== r.sha256) throw new Error('The firmware file doesn\'t match its build record');
    return { bytes, sha256: hex };
  }
  const binName = c => (c.meta.name || c.id).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) + '-' + c.build.commit.slice(0, 8) + '.bin';

  // Flash: hand the build to Flasher in this browser (IndexedDB dovetail-handoff, as Signoff EE hands runs to
  // Fabcheck) and open it there on ?jig=<project>/<commit>. Flasher checks the SHA-256 again, and reads jig_data
  // itself when the hand-off isn't there (a link opened later).
  async function flash() {
    const c = state.cur, r = c && c.build && c.build.result;
    if (!r || !r.ok || c.dirty || state.flashing) return;
    const board = state.index && state.index.boards[c.meta.board];
    state.flashing = true; renderToolbar();
    try {
      const b = await buildBytes();
      await window.Signoff.handoff.put({ id: 'jig:' + c.id + '/' + c.build.commit, tool: 'jig', name: binName(c), bytes: b.bytes, sha256: b.sha256,
        board: (board && board.flasher) || '', projectName: c.meta.name || c.id, commit: c.build.commit, at: new Date().toISOString() }, DEMO);
      location.href = '../flasher/index.html?' + (DEMO ? 'demo&' : '') + 'jig=' + encodeURIComponent(c.id) + '/' + c.build.commit;
    } catch (e) {
      state.flashing = false; renderToolbar();
      toast('Couldn\'t hand the build to Flasher: ' + (e.message || e), 'error');
    }
  }

  async function download() {
    const c = state.cur, r = c && c.build && c.build.result;
    if (!r || !r.ok) return;
    try {
      const { bytes } = await buildBytes();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      a.download = binName(c);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast(e.message || String(e), 'error'); }
  }

  // ── Rendering ──
  function renderAll() { renderSide(); renderToolbar(); renderView(); }

  function renderSide() {
    const el = $('#project-list');
    if (!state.store) { el.innerHTML = '<div class="side-empty">' + (DEMO ? '' : 'Sign in to see projects.') + '</div>'; return; }
    if (!state.index) { el.innerHTML = '<div class="side-empty">' + (state.loading ? 'Loading…' : '') + '</div>'; return; }
    const ps = state.index.projects.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (!ps.length) { el.innerHTML = '<div class="side-empty">No projects yet.</div>'; return; }
    el.innerHTML = ps.map(p => {
      const on = state.cur && state.cur.id === p.id, dirty = on && state.cur.dirty;
      return '<button class="proj' + (on ? ' active' : '') + '" data-open="' + esc(p.id) + '"><span class="jg-ico">' + ICON.code + '</span>' +
        '<span class="proj-body"><span class="proj-name">' + esc(p.name || p.id) + '</span><span class="proj-sub">' + esc(boardName(p.board)) +
        (p.updatedAt ? ' · ' + esc(ago(p.updatedAt)) : '') + '</span></span>' + (dirty ? '<span class="proj-dirty" title="Unsaved edits"></span>' : '') + '</button>';
    }).join('');
  }

  function renderToolbar() {
    const c = state.cur, t = $('#toolbar-title'), a = $('#toolbar-actions');
    if (!c || c.loading) { t.innerHTML = c ? '<span class="jg-muted">Opening…</span>' : ''; a.innerHTML = ''; return; }
    t.innerHTML = '<span class="jg-title">' + esc(c.meta.name || c.id) + '</span><span class="chip jg-board-chip">' + esc(boardName(c.meta.board)) + '</span>' +
      (c.dirty ? '<span class="jg-unsaved">Unsaved</span>' : '');
    const r = c.build && c.build.result;
    a.innerHTML =
      '<button class="btn" data-act="download"' + (r && r.ok && !c.dirty ? '' : ' disabled') + ' title="' + (r && r.ok ? (c.dirty ? 'Build your edits first' : 'Download this build\'s .bin') : 'No passing build yet') + '">' + ICON.down + ' .bin</button>' +
      '<button class="btn" data-act="flash"' + (r && r.ok && !c.dirty && !state.flashing ? '' : ' disabled') + ' title="' + (r && r.ok ? (c.dirty ? 'Build your edits first' : 'Open this build in Flasher, ready to flash its board') : 'No passing build yet') + '">' + ICON.bolt + (state.flashing ? ' Opening Flasher…' : ' Flash') + '</button>' +
      '<button class="btn btn-primary" data-act="save"' + (c.saving ? ' disabled' : '') + ' title="Save to ' + esc(state.store.repo) + ' and build (Ctrl+S)">' + (c.saving ? 'Saving…' : 'Save and build') + '</button>';
  }

  function renderView() {
    const v = $('#view'), c = state.cur;
    if (!c) { ed = null; v.innerHTML = homeHtml(); return; }
    if (c.loading) { ed = null; v.innerHTML = '<div class="page"><p class="jg-muted">Opening ' + esc(c.id) + '…</p></div>'; return; }
    if (!ed || !document.contains(ed.el)) {
      v.innerHTML = '<div class="jg-work"><div class="jg-tabs" id="file-tabs"></div><div class="jg-edwrap" id="ed"></div><section class="jg-build" id="build"></section></div>';
      ed = JIG.editor.create($('#ed'), { onChange: edited, onSave: () => save() });
      ed.set(c.files[c.file] || '');
    }
    renderTabs(); renderBuild(); showMarks();
  }

  function renderTabs() {
    const c = state.cur, el = $('#file-tabs');
    if (!el || !c) return;
    const main = mainFile(c), r = c.build && c.build.result;
    const count = n => r ? (r.messages || []).filter(m => m.file === n && m.severity === 'error').length : 0;
    const names = Object.keys(c.files).sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
    el.innerHTML = names.map(n => '<button class="jg-tab' + (n === c.file ? ' on' : '') + '" data-file="' + esc(n) + '">' + esc(n) +
      (count(n) ? '<span class="jg-tab-err" title="' + count(n) + ' error(s)">✕ ' + count(n) + '</span>' : '') +
      (n !== main ? '<span class="jg-tab-x" data-rmfile="' + esc(n) + '" title="Remove ' + esc(n) + '">×</span>' : '') + '</button>').join('') +
      '<button class="jg-tab jg-tab-add" data-act="addfile" title="Add a file to the sketch">' + ICON.plus + '</button>';
  }

  function renderBuild() {
    const el = $('#build'), c = state.cur;
    if (!el || !c) return;
    const w = state.wait && state.wait.id === c.id && c.build && state.wait.commit === c.build.commit ? state.wait : null;
    const r = c.build && c.build.result;
    let h = '';
    if (w && w.gaveUp) {
      h = '<div class="jg-bhead"><span class="jg-state jg-state-warn">▲ No result after 10 minutes</span></div><p class="jg-bnote">The build of ' + esc(w.commit.slice(0, 8)) +
        ' hasn\'t written its result. GitHub Actions may be queued or off in ' + esc(DATA.repo) + '. <a href="https://github.com/' + DATA.owner + '/' + DATA.repo + '/actions" target="_blank" rel="noopener">See the builds on GitHub</a> · <button class="jg-link" data-act="rewait">Keep waiting</button></p>';
    } else if (w) {
      const s = Math.round((Date.now() - w.t0) / 1000);
      h = '<div class="jg-bhead"><span class="jg-state jg-state-busy"><span class="jg-spin"></span>Building ' + esc(w.commit.slice(0, 8)) + '…</span><span class="jg-muted">' + s + ' s</span></div>' +
        '<p class="jg-bnote">' + (DEMO ? 'The demo simulates the build in this browser.' : 'GitHub Actions in ' + esc(DATA.repo) + ' is compiling it. A build usually takes under a minute, longer the first time after the board package changes.') + '</p>';
    } else if (r) {
      const errs = (r.messages || []).filter(m => m.severity === 'error'), warns = (r.messages || []).filter(m => m.severity === 'warning');
      h = '<div class="jg-bhead">' + (r.ok ? '<span class="jg-state jg-state-ok">✓ Built</span>' : '<span class="jg-state jg-state-err">✕ Build failed</span>') +
        '<span class="jg-muted">' + esc(String(r.commit || '').slice(0, 8)) + (r.seconds != null ? ' · ' + esc(Number(r.seconds)) + ' s' : '') + (r.startedAt ? ' · ' + esc(ago(r.startedAt)) : '') + '</span>' +
        (c.dirty ? '<span class="jg-muted">· your edits since aren\'t built</span>' : '') + '</div>';
      if (r.ok && r.size) {
        const bar = (n, max, label) => max ? '<div class="jg-use"><span>' + label + '</span><div class="jg-use-bar"><i style="width:' + Math.min(100, n / max * 100).toFixed(1) + '%"></i></div><span class="jg-muted">' + kb(n) + ' of ' + kb(max) + ' (' + Math.round(n / max * 100) + '%)</span></div>' : '';
        h += '<div class="jg-uses">' + bar(+r.size.flash || 0, +r.size.flashMax || 0, 'Flash') + bar(+r.size.ram || 0, +r.size.ramMax || 0, 'RAM') + '</div>';
      }
      const list = errs.concat(warns);
      if (list.length) h += '<ul class="jg-msgs">' + list.map((m, i) => '<li><button class="jg-msg jg-msg-' + (m.severity === 'error' ? 'err' : 'warn') + '" data-msg="' + i + '">' +
        '<span class="jg-msg-sev">' + (m.severity === 'error' ? '✕' : '▲') + '</span><span class="jg-msg-at">' + esc(m.file || '') + (m.line ? ':' + esc(Number(m.line)) : '') + '</span><span class="jg-msg-text">' + esc(m.text) + '</span></button></li>').join('') + '</ul>';
      if (r.log) h += '<details class="jg-log"' + (state.logOpen ? ' open' : '') + '><summary>Compiler output</summary><pre>' + esc(r.log) + '</pre></details>';
      if (r.boardPackage || r.core) h += '<p class="jg-bnote jg-muted">' + esc(r.fqbn || '') + (r.core ? ' · core ' + esc(r.core) : '') + (r.boardPackage ? ' · board package ' + esc(r.boardPackage.repo || '') + ' ' + esc(String(r.boardPackage.commit || '').slice(0, 8)) : '') + '</p>';
      el._msgs = list;
    } else {
      h = '<div class="jg-bhead"><span class="jg-muted">Not built yet. Save and build sends it to ' + (DEMO ? 'the demo\'s simulated build' : 'GitHub Actions') + '.</span></div>';
    }
    el.innerHTML = h;
    const d = el.querySelector('details'); if (d) d.addEventListener('toggle', () => { state.logOpen = d.open; });
  }

  function homeHtml() {
    if (!DEMO && !state.store) {
      return '<div class="page jg-home"><div class="eyebrow">Prototype</div><h1 class="page-title">Jig</h1>' +
        '<p class="jg-lede">Edit Arduino sketches for Dovetail boards in the browser. Saving a sketch builds it with GitHub Actions, and the firmware goes to Flasher. Sign in with GitHub to see the projects.</p>' +
        '<div class="jg-btns"><button class="btn btn-primary" data-act="signin">Sign in</button><a class="btn" href="?demo">Try the demo</a></div></div>';
    }
    if (state.error) return '<div class="page jg-home"><h1 class="page-title">Jig</h1><p class="jg-lede jg-err">' + esc(state.error) + '</p></div>';
    if (!state.index) return '<div class="page"><p class="jg-muted">Loading projects…</p></div>';
    const n = state.index.projects.length;
    return '<div class="page jg-home"><div class="eyebrow">' + (DEMO ? 'Demo' : esc(DATA.repo)) + '</div><h1 class="page-title">Jig</h1>' +
      '<p class="jg-lede">Pick a project on the left, or start one. Saving a sketch builds it' + (DEMO ? ' (simulated here)' : ' with GitHub Actions in ' + esc(DATA.repo)) + '; Flash opens a passing build in Flasher, ready for its board.</p>' +
      '<div class="jg-btns"><button class="btn btn-primary" data-act="new">' + ICON.plus + ' New project</button>' + (DEMO ? '<button class="btn" data-act="reset">Reset the demo</button>' : '') + '</div>' +
      '<p class="jg-muted">' + n + ' project' + (n === 1 ? '' : 's') + ' · ' + Object.keys(state.index.boards).length + ' board' + (Object.keys(state.index.boards).length === 1 ? '' : 's') + '</p></div>';
  }

  // ── Sheets ──
  function sheet(html, onReady) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    if (onReady) onReady(wrap, close);
    return close;
  }

  function newProject(boardId) {
    if (!state.index) return;
    const bs = state.index.boards, ids = Object.keys(bs);
    if (!ids.length) { toast('No boards in ' + DATA.repo + ' yet', 'error'); return; }
    const pick = bs[boardId] ? boardId : ids[0];
    const exOpts = b => '<option value="">An empty sketch</option>' + (state.index.examples[b] || []).map(x => '<option value="' + esc(x.name) + '">Example: ' + esc(x.name) + '</option>').join('');
    sheet('<div class="sheet-head"><h2>New project</h2><p>A sketch for one board. It\'s saved to ' + esc(state.store.repo) + ' and built when you save it.</p></div>' +
      '<div class="sheet-body"><div class="field"><label for="np-name">Name</label><input id="np-name" class="jg-input" maxlength="80" placeholder="What it does, like Fan speed test"></div>' +
      '<div class="field"><label for="np-board">Board</label><select id="np-board" class="jg-input">' + ids.map(i => '<option value="' + esc(i) + '"' + (i === pick ? ' selected' : '') + '>' + esc(bs[i].name) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="np-from">Start from</label><select id="np-from" class="jg-input">' + exOpts(pick) + '</select></div></div>' +
      '<div class="sheet-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="np-go">Create</button></div>', (wrap, close) => {
      const name = wrap.querySelector('#np-name'), board = wrap.querySelector('#np-board'), from = wrap.querySelector('#np-from');
      board.addEventListener('change', () => { from.innerHTML = exOpts(board.value); });
      const ex = (state.index.examples[pick] || [])[0];
      if (ex) from.value = (state.index.examples[pick].find(x => /^blink$/i.test(x.name)) || ex).name;
      setTimeout(() => name.focus(), 30);
      name.addEventListener('keydown', e => { if (e.key === 'Enter') wrap.querySelector('#np-go').click(); });
      wrap.querySelector('#np-go').addEventListener('click', async () => {
        const nm = name.value.trim();
        if (!nm) { name.focus(); return; }
        const btn = wrap.querySelector('#np-go'); btn.disabled = true; btn.textContent = 'Creating…';
        try {
          let files;
          if (from.value) files = await state.store.example(board.value, from.value);
          else {
            const base = nm.replace(/[^A-Za-z0-9_]+/g, '').replace(/^([0-9])/, '_$1').slice(0, 40) || 'Sketch';
            files = { [base + '.ino']: 'void setup() {\n\n}\n\nvoid loop() {\n\n}\n' };
          }
          if (!Object.keys(files).some(n => n.endsWith('.ino'))) throw new Error('That example has no .ino file');
          const id = JIG.store.makeId(nm), at = new Date().toISOString();
          const meta = { name: nm, board: board.value, createdAt: at, createdBy: who(), updatedAt: at, updatedBy: who() };
          const r = await state.store.save(id, meta, files, null);
          close();
          await refreshIndex();
          state.cur = null;
          await openProject(id);
          if (r.commit && state.cur && state.cur.id === id) { state.cur.build = { commit: r.commit, result: null }; wait(id, r.commit, Date.now()); renderAll(); }
        } catch (e) { btn.disabled = false; btn.textContent = 'Create'; toast(e.message || String(e), 'error'); }
      });
    });
  }

  function addFile() {
    const c = state.cur;
    if (!c) return;
    sheet('<div class="sheet-head"><h2>Add a file</h2><p>A header or source file beside the sketch: .h, .hpp, .c, .cpp, or another .ino.</p></div>' +
      '<div class="sheet-body"><div class="field"><label for="af-name">File name</label><input id="af-name" class="jg-input" maxlength="80" placeholder="pins.h"></div></div>' +
      '<div class="sheet-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="af-go">Add</button></div>', (wrap, close) => {
      const inp = wrap.querySelector('#af-name');
      setTimeout(() => inp.focus(), 30);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') wrap.querySelector('#af-go').click(); });
      wrap.querySelector('#af-go').addEventListener('click', () => {
        const n = inp.value.trim();
        if (!JIG.store.okFile(n)) { toast('Use letters, digits, _, -, and . in the name, ending .ino, .h, .hpp, .c, .cpp, or .S', 'error'); return; }
        if (c.files[n] != null) { toast(n + ' is already in the sketch', 'error'); return; }
        c.files[n] = /\.(h|hpp)$/.test(n) ? '#pragma once\n\n' : '';
        c.file = n; c.dirty = true; close();
        if (ed) ed.set(c.files[n]);
        keepDraft(); renderAll(); if (ed) ed.focus();
      });
    });
  }

  function conflictSheet() {
    sheet('<div class="sheet-head"><h2>Saved by someone else</h2><p>Someone saved this project since you opened it. Saving yours replaces their version (git keeps theirs). Reloading drops your edits.</p></div>' +
      '<div class="sheet-foot"><button class="btn" data-close>Cancel</button><button class="btn" id="cf-reload">Reload theirs</button><button class="btn btn-primary" id="cf-mine">Save mine</button></div>', (wrap, close) => {
      wrap.querySelector('#cf-mine').addEventListener('click', () => { close(); save(true); });
      wrap.querySelector('#cf-reload').addEventListener('click', async () => {
        close(); const id = state.cur.id; await drafts.del(id); state.cur = null; openProject(id);
      });
    });
  }

  // ── Clicks ──
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act], [data-open], [data-file], [data-rmfile], [data-msg]');
    if (!t) return;
    if (t.dataset.rmfile) {
      e.stopPropagation();
      const c = state.cur, n = t.dataset.rmfile;
      if (!c || !confirm('Remove ' + n + ' from the sketch? It goes when you save (git keeps it).')) return;
      delete c.files[n]; c.dirty = true;
      if (c.file === n) { c.file = mainFile(c); if (ed) ed.set(c.files[c.file] || ''); }
      keepDraft(); renderAll(); return;
    }
    if (t.dataset.open) { openProject(t.dataset.open); return; }
    if (t.dataset.file) {
      const c = state.cur;
      if (c && t.dataset.file !== c.file) { c.file = t.dataset.file; if (ed) ed.set(c.files[c.file] || ''); renderTabs(); showMarks(); }
      return;
    }
    if (t.dataset.msg != null) {
      const m = ($('#build')._msgs || [])[+t.dataset.msg], c = state.cur;
      if (!m || !c) return;
      if (m.file && c.files[m.file] != null && m.file !== c.file) { c.file = m.file; ed.set(c.files[c.file]); renderTabs(); showMarks(); }
      if (m.line && (m.file === c.file)) ed.go(m.line, m.col);
      return;
    }
    const a = t.dataset.act;
    if (a === 'nav') toggleSidebar();
    else if (a === 'home') { if (state.cur && state.cur.dirty) keepDraft(); state.cur = null; ed = null; setLink(null); renderAll(); }
    else if (a === 'theme') { const t2 = isDark(readTheme()) ? 'light' : 'dark'; writeTheme(t2); applyTheme(t2); }
    else if (a === 'new') { if (!state.store) { if (window.SignoffFoot) window.SignoffFoot.settings(); } else newProject(state.cur && state.cur.meta.board); }
    else if (a === 'save') save();
    else if (a === 'download') download();
    else if (a === 'flash') flash();
    else if (a === 'addfile') addFile();
    else if (a === 'signin') { if (window.SignoffFoot) window.SignoffFoot.settings(); }
    else if (a === 'rewait' && state.wait) wait(state.wait.id, state.wait.commit, Date.now());
    else if (a === 'reset' && DEMO && confirm('Put the demo\'s projects back as they started?')) { state.store.reset(); drafts.del('status-led-k3m9'); drafts.del('room-temp-p2x7'); start(); }
  });
  window.addEventListener('beforeunload', e => { if (state.cur && state.cur.dirty) keepDraft(); });

  // ── Updates: reload when the site serves a newer build, only with nothing in flight ──
  const UPDATE_KEY = 'signoff.toolUpdate.jig';
  function checkForUpdate() {
    const have = JIG.VERSION || '';
    if (!have || !window.fetch) return;
    fetch('assets/version.js?nc=' + Date.now(), { cache: 'no-store' }).then(r => (r.ok ? r.text() : '')).then(text => {
      const m = /VERSION\s*=\s*["']([0-9a-f]+)["']/.exec(text || '');
      if (!m || m[1] === have) return;
      let tried = ''; try { tried = sessionStorage.getItem(UPDATE_KEY) || ''; } catch (e) { /* blocked */ }
      if (tried === m[1] || document.querySelector('.sheet-wrap') || state.wait || (state.cur && (state.cur.dirty || state.cur.saving))) return;
      try { sessionStorage.setItem(UPDATE_KEY, m[1]); } catch (e) { /* blocked */ }
      location.reload();
    }).catch(() => {});
  }

  // ── Start ──
  applyTheme(readTheme());
  try { if (localStorage.getItem(SIDE_KEY) === '1') { const app = $('#app'); app.style.transition = 'none'; app.classList.add('side-collapsed'); void app.offsetWidth; app.style.transition = ''; } } catch (e) { /* blocked */ }
  if (DEMO) {
    const b = $('#demo-banner');
    b.hidden = false; document.body.classList.add('has-banner');
    b.innerHTML = 'Demo: the made-up Smart Thermostat for Acme Climate. Projects live in this browser and builds are simulated. <a href="./">Leave the demo</a>';
    document.querySelectorAll('[data-demo-href]').forEach(a => { a.href = a.getAttribute('href') + '?demo'; });
  }
  $('#version').textContent = 'Build ' + (JIG.VERSION || 'dev');
  if (window.SignoffFoot) window.SignoffFoot.mount({
    pill: '#sync-pill', settings: '[data-foot-settings]', tools: '#side-tools',
    theme: readTheme, setTheme: t => { writeTheme(t); applyTheme(t); },
    intro: 'Jig keeps its projects and builds in the private ' + DATA.repo + ' repo. Sign in with GitHub to open them.',
    changed: () => { if (!DEMO) start(); }
  });
  JIG.app = { state, save, openProject, newProject, poll };
  start();
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, 5 * 60000);
})(window.JIG = window.JIG || {});
