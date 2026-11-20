// Jig's data: projects, boards, examples, and builds in the private jig_data repo (docs/design.md, *Repos*),
// or in this browser for the demo. Both stores have the same calls:
//
//   open()                         { boards, projects: [meta…], examples: { board: [{ name, dir }] } }
//   load(id)                       { meta, files: { name: text }, shas: { name: blob sha }, build: { commit, result } | null }
//   example(board, name)           { name: text } of one example
//   save(id, meta, files, shas)    commits the project; resolves { commit } (null when nothing changed).
//                                  Rejects with code 'conflict' when someone else saved it since `shas` were read.
//   result(id, commit)             the build's result (jig.build/1), or null while it isn't there yet
//   binary(id, commit)             the build's .bin as a Uint8Array
//
// JIG.drafts keeps unsaved edits in IndexedDB (localStorage without it), so a reload loses nothing.
(function (JIG) {
  'use strict';
  const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
  const EXT_RE = /\.(ino|h|hpp|c|cpp|S)$/;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const okFile = n => FILE_RE.test(n) && EXT_RE.test(n);
  const now = () => new Date().toISOString();

  function makeId(name) {
    const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    let tail = ''; const r = crypto.getRandomValues(new Uint8Array(4));
    for (const b of r) tail += abc[b % abc.length];
    return slug + '-' + tail;
  }
  // project.json as the page writes it: only known fields, so a file can't carry anything else along.
  function cleanMeta(m) {
    const o = {};
    for (const k of ['name', 'board', 'main', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']) if (typeof m[k] === 'string' && m[k]) o[k] = m[k].slice(0, 200);
    return o;
  }
  const json = o => JSON.stringify(o, null, 2) + '\n';

  // ── Unsaved edits ──
  function kv(demo) {
    const name = demo ? 'jig-local-demo' : 'jig-local';
    let dbp = null;
    function db() {
      if (!dbp) dbp = new Promise((res, rej) => {
        if (!window.indexedDB) return rej(new Error('no IndexedDB'));
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('drafts');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    const lsKey = k => name + '.' + k;
    function tx(mode, fn) {
      return db().then(d => new Promise((res, rej) => {
        const t = d.transaction('drafts', mode), req = fn(t.objectStore('drafts'));
        t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
      }));
    }
    return {
      get: k => tx('readonly', s => s.get(k)).catch(() => { try { return JSON.parse(localStorage.getItem(lsKey(k))); } catch (e) { return null; } }),
      put: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => { try { localStorage.setItem(lsKey(k), JSON.stringify(v)); } catch (e) { /* full */ } }),
      del: k => tx('readwrite', s => s.delete(k)).catch(() => { try { localStorage.removeItem(lsKey(k)); } catch (e) { /* blocked */ } })
    };
  }

  // ── The real store: jig_data on GitHub ──
  function GitHubJig(cfg, fetchImpl) {
    const gs = new window.Signoff.GitHubStore({ owner: cfg.owner, repo: cfg.repo, branch: 'main', token: cfg.token }, fetchImpl);
    const blobs = new Map();
    const text = sha => blobs.has(sha) ? Promise.resolve(blobs.get(sha)) : gs.blob(sha).then(t => { blobs.set(sha, t); return t; });
    const enc = p => p.split('/').map(encodeURIComponent).join('/');
    let boardsJson = null;

    function contents(path) {
      return gs.api('/contents/' + enc(path) + '?ref=main').catch(e => { if (e.status === 404) return null; throw e; });
    }
    function b64bytes(s) { const bin = atob(String(s).replace(/\s+/g, '')); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

    async function open() {
      const snap = await gs.snapshot();
      const e = {}; for (const x of snap.entries) if (x.type === 'blob') e[x.path] = x.sha;
      if (!e['boards.json']) throw new Error(cfg.owner + '/' + cfg.repo + ' has no boards.json yet. Run jig/tools/sync_data.py first.');
      boardsJson = JSON.parse(await text(e['boards.json']));
      const boards = boardsJson.boards || {};
      const ids = Object.keys(e).map(p => (/^projects\/([a-z0-9][a-z0-9-]*)\/project\.json$/.exec(p) || [])[1]).filter(Boolean);
      const projects = await Promise.all(ids.map(id => text(e['projects/' + id + '/project.json']).then(t => {
        try { return Object.assign(cleanMeta(JSON.parse(t)), { id }); } catch (err) { return { id, name: id, broken: true }; }
      })));
      const examples = {};
      for (const [bid, b] of Object.entries(boards)) {
        const dir = String(b.examples || '').replace(/\/+$/, '') + '/';
        const names = new Set();
        if (b.examples) for (const p of Object.keys(e)) if (p.startsWith(dir)) { const rest = p.slice(dir.length).split('/'); if (rest.length === 2 && okFile(rest[1])) names.add(rest[0]); }
        examples[bid] = [...names].sort().map(n => ({ name: n, dir: dir + n + '/' }));
      }
      return { boards, projects, examples, head: snap.head };
    }

    async function load(id) {
      if (!ID_RE.test(id)) throw new Error('Not a project id: ' + id);
      const snap = await gs.snapshot();
      const dir = 'projects/' + id + '/sketch/', files = {}, shas = {};
      let metaSha = null;
      for (const x of snap.entries) {
        if (x.type !== 'blob') continue;
        if (x.path === 'projects/' + id + '/project.json') metaSha = x.sha;
        else if (x.path.startsWith(dir) && okFile(x.path.slice(dir.length))) shas[x.path.slice(dir.length)] = x.sha;
      }
      if (!metaSha) throw new Error('That project isn\'t in ' + cfg.repo + ' any more.');
      const meta = Object.assign(cleanMeta(JSON.parse(await text(metaSha))), { id });
      await Promise.all(Object.keys(shas).map(n => text(shas[n]).then(t => { files[n] = t; })));
      // The last build: the newest commit that touched the project, and its result if the build has written one.
      let build = null;
      try {
        const list = await gs.api('/commits?sha=main&per_page=1&path=' + encodeURIComponent('projects/' + id));
        const commit = list && list[0] && list[0].sha;
        if (commit) build = { commit, result: await result(id, commit) };
      } catch (err) { /* history is a nicety */ }
      return { meta, files, shas, build };
    }

    async function example(board, name) {
      const ex = ((await open()).examples[board] || []).find(x => x.name === name);
      if (!ex) throw new Error('No example called ' + name);
      const snap = await gs.snapshot(), files = {};
      await Promise.all(snap.entries.filter(x => x.type === 'blob' && x.path.startsWith(ex.dir) && okFile(x.path.slice(ex.dir.length)))
        .map(x => text(x.sha).then(t => { files[x.path.slice(ex.dir.length)] = t; })));
      return files;
    }

    async function save(id, meta, files, shas) {
      if (!ID_RE.test(id)) throw new Error('Not a project id: ' + id);
      for (const n of Object.keys(files)) if (!okFile(n)) throw new Error('Jig can\'t save a file called ' + n);
      const snap = await gs.snapshot(), dir = 'projects/' + id + '/sketch/', now_ = {};
      for (const x of snap.entries) if (x.type === 'blob' && x.path.startsWith(dir)) now_[x.path.slice(dir.length)] = x.sha;
      // Someone else's save since this copy was read: the files on GitHub aren't the ones this copy started from.
      const same = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.join('\0') === kb.join('\0') && ka.every(k => a[k] === b[k]); };
      if (shas && !same(now_, shas)) { const e = new Error('Someone else saved this project since you opened it.'); e.code = 'conflict'; throw e; }
      const writes = Object.keys(files).map(n => ({ path: dir + n, text: files[n] }));
      for (const n of Object.keys(now_)) if (!(n in files)) writes.push({ path: dir + n, remove: true });
      const metaPath = 'projects/' + id + '/project.json';
      const hadMeta = snap.entries.some(x => x.path === metaPath);
      // Only a change to the sketch (or a new project) is a save worth a commit and a build.
      if (hadMeta && same(await shasOf(files), now_)) return { commit: null };
      writes.push({ path: metaPath, text: json(cleanMeta(Object.assign({}, meta, { updatedAt: now(), updatedBy: cfg.who || meta.updatedBy || '' }))) });
      const r = await gs.putFiles(writes, { message: 'Jig: save ' + (meta.name || id) });
      return { commit: r.head };
    }

    async function shasOf(files) {
      const out = {};
      await Promise.all(Object.keys(files).map(async n => {
        const body = new TextEncoder().encode(files[n]), head = new TextEncoder().encode('blob ' + body.length + '\0');
        const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
        const d = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
        out[n] = Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
      }));
      return out;
    }

    async function result(id, commit) {
      const f = await contents('builds/' + id + '/' + commit + '.json');
      if (!f) return null;
      const t = f.content ? new TextDecoder().decode(b64bytes(f.content)) : await text(f.sha);
      return JSON.parse(t);
    }
    async function binary(id, commit) {
      const f = await contents('builds/' + id + '/' + commit + '.bin');
      if (!f) throw new Error('That build has no firmware file.');
      if (f.content) return b64bytes(f.content);
      const b = await gs.api('/git/blobs/' + f.sha);
      return b64bytes(b.content);
    }

    // Where a build has got to in GitHub Actions: the run for that commit and its jobs' steps, as stages (stagesFrom),
    // with how long the last finished build took. Needs Actions: Read on the sign-in; without it, { noAccess: true }.
    async function progress(id, commit) {
      let runs;
      try { runs = await gs.api('/actions/runs?branch=main&per_page=10'); }
      catch (e) { if (e.status === 403 || e.status === 404) return { noAccess: true, logUrl: checksUrl(commit) }; throw e; }
      const list = (runs && runs.workflow_runs) || [];
      const run = list.find(r => r.head_sha === commit) || null;
      const last = list.find(r => r.head_sha !== commit && r.status === 'completed' && r.conclusion === 'success' && r.run_started_at);
      const usual = last ? Math.round((Date.parse(last.updated_at) - Date.parse(last.run_started_at)) / 1000) : null;
      let jobs = [];
      if (run) { try { jobs = ((await gs.api('/actions/runs/' + run.id + '/jobs')) || {}).jobs || []; } catch (e) { jobs = []; } }
      return { stages: stagesFrom(run, jobs), usual, logUrl: run && /^https:\/\/github\.com\//.test(run.html_url) ? run.html_url : checksUrl(commit) };
    }
    const checksUrl = commit => 'https://github.com/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/commit/' + commit + '/checks';

    return { kind: 'github', open, load, example, save, result, binary, shasOf, progress, logUrl: checksUrl, repo: cfg.owner + '/' + cfg.repo };
  }

  // A run and its jobs (GitHub's Actions API) as Jig's four stages. Each: { key, label, state: 'todo' | 'now' | 'done' |
  // 'failed', start, end } (ISO times, or null). Matched to tools/workflow/build.yml by job and step names.
  const STAGES = [
    { key: 'queue', label: 'Waiting for GitHub to start it' },
    { key: 'tools', label: 'Getting the board\'s tools ready' },
    { key: 'compile', label: 'Compiling' },
    { key: 'publish', label: 'Saving the result' }
  ];
  function stagesFrom(run, jobs) {
    const out = STAGES.map(s => Object.assign({ state: 'todo', start: null, end: null }, s));
    const [queue, tools, compile, publish] = out;
    const job = name => (jobs || []).find(j => j.name === name);
    const failed = x => x && (x.conclusion === 'failure' || x.conclusion === 'cancelled' || x.conclusion === 'timed_out');
    queue.start = run ? run.created_at : null;
    const build = job('build'), pub = job('publish'), plan = job('plan');
    if (!build || !build.started_at || build.status === 'queued') {
      queue.state = failed(plan) || (run && failed(run) && !build) ? 'failed' : 'now';
      return out;
    }
    queue.state = 'done'; queue.end = build.started_at;
    const steps = build.steps || [], bstep = steps.find(s => s.name === 'Build');
    tools.start = build.started_at;
    if (!bstep || bstep.status === 'queued' || bstep.status === 'pending' || !bstep.started_at) {
      tools.state = failed(build) || steps.some(failed) ? 'failed' : 'now';
      return out;
    }
    tools.state = 'done'; tools.end = bstep.started_at;
    compile.start = bstep.started_at;
    if (bstep.status !== 'completed') { compile.state = 'now'; return out; }
    compile.end = bstep.completed_at; compile.state = failed(bstep) ? 'failed' : 'done';
    if (compile.state === 'failed') return out;
    if (!pub || !pub.started_at || pub.status === 'queued') { publish.state = 'now'; publish.start = compile.end; return out; }
    publish.start = pub.started_at;
    if (pub.status !== 'completed') { publish.state = 'now'; return out; }
    publish.end = pub.completed_at; publish.state = failed(pub) ? 'failed' : 'done';
    return out;
  }

  // ── The demo store: this browser ──
  function DemoJig() {
    const KEY = 'jig.demo.v1', D = JIG.demo;
    let st;
    try { st = JSON.parse(localStorage.getItem(KEY)); } catch (e) { st = null; }
    if (!st || !st.projects) st = { projects: D.projects(), builds: {} };
    const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* full or blocked */ } };
    const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const shas = files => { const o = {}; for (const n of Object.keys(files)) o[n] = String(files[n].length) + ':' + hashStr(files[n]); return o; };
    function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
    const metaOf = p => Object.assign(cleanMeta(p), { id: p.id });

    function simulate(id, commit, files, main) {
      const board = D.boards[st.projects[id].board] || {};
      const started = now(), t0 = Date.now();
      return delay(2200 + Math.random() * 1200).then(() => {
        const messages = D.check(files, main);
        const ok = !messages.some(m => m.severity === 'error');
        const bin = ok ? D.binary(files) : null;
        const res = { format: 'jig.build/1', project: id, commit, board: st.projects[id].board, fqbn: board.fqbn, core: 'acme:stm32@1.0.0',
          boardPackage: { repo: 'acme/thermostat-arduino', commit: 'demo' }, ok, startedAt: started, seconds: Math.round((Date.now() - t0) / 100) / 10,
          size: ok ? { flash: bin.length, flashMax: board.flashMax, ram: 2048 + Math.round(bin.length / 40), ramMax: board.ramMax } : null,
          messages, main, log: messages.length ? messages.map(m => (m.file || '') + (m.line ? ':' + m.line + (m.col ? ':' + m.col : '') : '') + ': ' + m.severity + ': ' + m.text).join('\n') + '\n' : 'Build finished.\n' };
        if (st.projects[id]) { (st.builds[id] = st.builds[id] || {})[commit] = res; (st.built = st.built || {})[commit] = files; keep(); }
      });
    }
    const mainOf = (meta, files) => meta.main || Object.keys(files).find(n => n.endsWith('.ino'));
    // The demo's stages, timed to its simulated build (about 2 to 3.5 s): queued, tools, compiling, then saving.
    const startedAt = {};
    async function progress(id, commit) {
      const t0 = startedAt[commit], done = !!(st.builds[id] || {})[commit];
      const iso = ms => new Date(ms).toISOString(), edges = [0, 500, 1200, 2000];
      const out = stagesFrom(null, []);
      if (!t0) return { stages: out.map(x => Object.assign(x, { state: done ? 'done' : 'todo' })), usual: 3, logUrl: '' };
      const el = Date.now() - t0;
      out.forEach((x, i) => {
        x.start = iso(t0 + edges[i]);
        const end = i < 3 ? edges[i + 1] : Infinity;
        if (done || el >= end) { x.state = 'done'; x.end = iso(t0 + Math.min(end === Infinity ? el : end, el)); }
        else if (el >= edges[i]) x.state = 'now';
        else { x.state = 'todo'; x.start = null; }
      });
      return { stages: out, usual: 3, logUrl: '' };
    }

    return {
      kind: 'demo',
      repo: 'this browser',
      open: async () => ({ boards: D.boards, projects: Object.values(st.projects).map(metaOf), examples: Object.fromEntries(Object.keys(D.examples).map(b => [b, D.examples[b].map(x => ({ name: x.name }))])) }),
      async load(id) {
        const p = st.projects[id];
        if (!p) throw new Error('That project isn\'t in this browser any more.');
        const b = st.builds[id] || {}, last = Object.values(b).sort((x, y) => x.startedAt < y.startedAt ? 1 : -1)[0];
        return { meta: metaOf(p), files: Object.assign({}, p.files), shas: shas(p.files), build: p.lastCommit ? { commit: p.lastCommit, result: b[p.lastCommit] || null } : (last ? { commit: last.commit, result: last } : null) };
      },
      example: async (board, name) => Object.assign({}, ((D.examples[board] || []).find(x => x.name === name) || {}).files),
      async save(id, meta, files, base) {
        const p = st.projects[id];
        if (p && base && JSON.stringify(shas(p.files)) !== JSON.stringify(base)) { const e = new Error('Someone else saved this project since you opened it.'); e.code = 'conflict'; throw e; }
        if (p && p.lastCommit && JSON.stringify(p.files) === JSON.stringify(files)) return { commit: null };   // never built yet: build it
        const commit = hex(20);
        st.projects[id] = Object.assign({}, cleanMeta(meta), { id, files: Object.assign({}, files), updatedAt: now(), updatedBy: meta.updatedBy || 'demo visitor', lastCommit: commit });
        keep();
        startedAt[commit] = Date.now();
        simulate(id, commit, files, mainOf(meta, files));
        return { commit };
      },
      result: async (id, commit) => (st.builds[id] || {})[commit] || null,
      async binary(id, commit) {
        const r = (st.builds[id] || {})[commit], files = (st.built || {})[commit];
        if (!r || !r.ok || !files) throw new Error('That build has no firmware file.');
        return D.binary(files);
      },
      shasOf: async files => shas(files),
      progress,
      logUrl: () => '',
      reset() { st = { projects: D.projects(), builds: {} }; keep(); }
    };
  }

  JIG.store = { GitHubJig, DemoJig, makeId, cleanMeta, okFile, kv, stagesFrom, STAGES };
})(window.JIG = window.JIG || {});
