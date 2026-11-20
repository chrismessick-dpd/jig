// Jig tests: open tests/test.html over http. The page title becomes PASS, FAIL, or ERROR.
(async function () {
  'use strict';
  const JIG = window.JIG;
  const out = [], fails = [], tests = [];
  const t = (name, fn) => tests.push([name, fn]);
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
  const ok = (c, msg) => { if (!c) throw new Error(msg || 'not true'); };
  const rejects = async (p, code) => { try { await p; } catch (e) { if (code && e.code !== code) throw new Error('rejected with ' + (e.code || e.message) + ', not ' + code); return; } throw new Error('did not reject'); };

  // ── Highlighting ──
  t('tokens: comments, strings, numbers, keywords, types, and Arduino names', () => {
    const k = JIG.cpp.tokens('// hi\nint x = 0x1F; /* a\nb */ digitalWrite(LED, HIGH); if (s == "a\\"b") foo(2.5f);');
    const cls = s => (k.find(x => x[1] === s) || [])[0];
    eq(cls('// hi'), 'com'); eq(cls('int'), 'type'); eq(cls('0x1F'), 'num'); eq(cls('/* a\nb */'), 'com');
    eq(cls('digitalWrite'), 'ard'); eq(cls('HIGH'), 'ard'); eq(cls('if'), 'kw'); eq(cls('"a\\"b"'), 'str'); eq(cls('foo'), 'fn'); eq(cls('2.5f'), 'num');
    eq(k.map(x => x[1]).join(''), '// hi\nint x = 0x1F; /* a\nb */ digitalWrite(LED, HIGH); if (s == "a\\"b") foo(2.5f);', 'tokens cover the text');
  });
  t('tokens: preprocessor lines, an #include file as a string, and # mid-line is not one', () => {
    const k = JIG.cpp.tokens('#include <Wire.h> // bus\n  #define N 3\nx = a#b;');
    eq(k[0], ['pp', '#include ']); eq(k[1], ['str', '<Wire.h>']); ok(k.some(x => x[0] === 'com' && x[1] === '// bus'));
    ok(k.some(x => x[0] === 'pp' && x[1] === '#define N 3'), 'indented #define');
    ok(!k.some(x => x[0] === 'pp' && x[1].startsWith('#b')), 'a # inside a line');
  });
  t('lines: one per line, a block comment split across them, HTML escaped', () => {
    const ls = JIG.cpp.lines('a < b\n/* x\ny */\n');
    eq(ls.length, 4); ok(ls[0].includes('&lt;')); ok(ls[1].includes('t-com') && ls[2].includes('t-com')); eq(ls[3], '');
  });

  // ── The editor ──
  t('editor: set, value, marks on lines, and go', () => {
    const host = document.createElement('div'); host.style.height = '200px'; document.body.appendChild(host);
    const ed = JIG.editor.create(host, {});
    ed.set('void setup() {\n}\nvoid loop() {}\n');
    eq(ed.value(), 'void setup() {\n}\nvoid loop() {}\n');
    eq(host.querySelectorAll('.jg-n').length, 4);
    ed.marks([{ line: 2, severity: 'error', text: 'oops' }, { line: 3, severity: 'warning', text: 'hmm' }]);
    eq([...host.querySelectorAll('.jg-n.is-err')].map(n => n.textContent), ['✕2']);
    eq(host.querySelectorAll('.jg-l.is-warn').length, 1);
    ok(host.querySelector('.jg-n.is-err').title.includes('oops'));
    ed.go(3, 6); eq(ed.el.selectionStart, 'void setup() {\n}\n'.length + 5);
    host.remove();
  });

  // ── The demo's simulated compiler ──
  t('demo check: a missing semicolon, unbalanced braces, #error, and no loop()', () => {
    const D = JIG.demo;
    eq(D.check({ 'A.ino': 'void setup() {}\nvoid loop() {\n  delay(10)\n}\n' }, 'A.ino').map(m => [m.line, m.text]), [[3, "expected ';' before '}'"]]);
    eq(D.check({ 'A.ino': 'void setup() {\n\nvoid loop() {}\n' }, 'A.ino').map(m => m.line), [1]);
    ok(D.check({ 'A.ino': 'void setup() {}\nvoid loop() {}\n', 'b.h': '#error not yet\n' }, 'A.ino').some(m => m.file === 'b.h' && m.line === 1));
    eq(D.check({ 'A.ino': 'void setup() {}\n// void loop() {}\n' }, 'A.ino').map(m => m.text), ["undefined reference to 'loop'"]);
    eq(D.check({ 'A.ino': 'void setup() { if (x) {\n  y();\n} }\nvoid loop() {\n  int s = "}";\n}\n' }, 'A.ino'), [], 'strings and if lines');
    for (const ex of D.examples['thermostat-main']) {
      const main = Object.keys(ex.files).find(n => n.endsWith('.ino'));
      eq(D.check(ex.files, main), [], ex.name + ' builds');
    }
  });

  // ── Ids and file names ──
  t('ids and file names', () => {
    const id = JIG.store.makeId('Fan speed test!');
    ok(/^fan-speed-test-[a-z0-9]{4}$/.test(id), id);
    ok(/^project-[a-z0-9]{4}$/.test(JIG.store.makeId('  ')));
    ok(JIG.store.okFile('Blink.ino') && JIG.store.okFile('pins.h') && JIG.store.okFile('drv_2.cpp'));
    ok(!JIG.store.okFile('../x.h') && !JIG.store.okFile('a.txt') && !JIG.store.okFile('.h') && !JIG.store.okFile('a b.c'));
    eq(JIG.store.cleanMeta({ name: 'N', board: 'b', evil: 'x', updatedAt: 3 }), { name: 'N', board: 'b' });
  });

  // ── The GitHub store, against a fake GitHub ──
  async function seeded() {
    const gh = window.FakeGitHub();
    const gs = new window.Signoff.GitHubStore({ owner: 'o', repo: 'jig_data', branch: 'main', token: 't' }, gh.fetch);
    await gs.putFiles([
      { path: 'boards.json', text: JSON.stringify({ format: 'jig.boards/1', core: { id: 'acme:stm32', version: '1.0.0' },
        boards: { b1: { name: 'Board one', fqbn: 'acme:stm32:b1', flasher: 'fl-b1', examples: 'board/hw/examples' } } }) },
      { path: 'board/hw/examples/Blink/Blink.ino', text: 'void setup() {}\nvoid loop() {}\n' },
      { path: 'board/hw/examples/Blink/notes.txt', text: 'not a sketch file' },
      { path: 'board/hw/examples/Two/Two.ino', text: '#include "p.h"\nvoid setup() {}\nvoid loop() {}\n' },
      { path: 'board/hw/examples/Two/p.h', text: '#pragma once\n' }
    ], { message: 'seed' });
    return { gh, gs, store: JIG.store.GitHubJig({ owner: 'o', repo: 'jig_data', token: 't', who: '@tester' }, gh.fetch) };
  }
  t('github: open lists boards, examples, and projects', async () => {
    const { store } = await seeded();
    const ix = await store.open();
    eq(Object.keys(ix.boards), ['b1']); eq(ix.examples.b1.map(x => x.name), ['Blink', 'Two']); eq(ix.projects, []);
    eq(Object.keys(await store.example('b1', 'Two')).sort(), ['Two.ino', 'p.h']);
  });
  t('github: save writes the sketch and project.json in one commit; load reads them back', async () => {
    const { gh, store } = await seeded();
    const before = gh.stats.commits;
    const r = await store.save('fan-ab12', { name: 'Fan', board: 'b1', createdBy: '@tester' }, { 'Fan.ino': 'void setup() {}\nvoid loop() {}\n', 'p.h': '#pragma once\n' }, null);
    ok(r.commit, 'a commit'); eq(gh.stats.commits, before + 1); eq(gh.head, r.commit);
    const p = await store.load('fan-ab12');
    eq(p.meta.name, 'Fan'); eq(p.meta.updatedBy, '@tester'); eq(Object.keys(p.files).sort(), ['Fan.ino', 'p.h']);
    eq(p.build && p.build.commit, r.commit, 'the last build is the save\'s commit'); eq(p.build.result, null, 'not built yet');
    eq((await store.open()).projects.map(x => x.id), ['fan-ab12']);
  });
  t('github: saving unchanged files makes no commit; a removed file is deleted', async () => {
    const { gh, store } = await seeded();
    const files = { 'Fan.ino': 'void setup() {}\nvoid loop() {}\n', 'p.h': '#pragma once\n' };
    await store.save('fan-ab12', { name: 'Fan', board: 'b1' }, files, null);
    const p = await store.load('fan-ab12'), n = gh.stats.commits;
    eq((await store.save('fan-ab12', p.meta, p.files, p.shas)).commit, null); eq(gh.stats.commits, n);
    const r = await store.save('fan-ab12', p.meta, { 'Fan.ino': files['Fan.ino'] }, p.shas);
    ok(r.commit); eq(Object.keys((await store.load('fan-ab12')).files), ['Fan.ino']);
  });
  t('github: a save over someone else\'s is refused as a conflict, and goes through when forced', async () => {
    const { store } = await seeded();
    await store.save('fan-ab12', { name: 'Fan', board: 'b1' }, { 'Fan.ino': 'void setup() {}\nvoid loop() {}\n' }, null);
    const mine = await store.load('fan-ab12'), theirs = await store.load('fan-ab12');
    await store.save('fan-ab12', theirs.meta, { 'Fan.ino': 'void setup() {}\nvoid loop() { delay(1); }\n' }, theirs.shas);
    await rejects(store.save('fan-ab12', mine.meta, { 'Fan.ino': 'void setup() { }\nvoid loop() {}\n' }, mine.shas), 'conflict');
    ok((await store.save('fan-ab12', mine.meta, { 'Fan.ino': 'void setup() { }\nvoid loop() {}\n' }, null)).commit);
  });
  t('github: refuses bad ids and file names', async () => {
    const { store } = await seeded();
    await rejects(store.save('../x', { name: 'x', board: 'b1' }, { 'A.ino': '' }, null));
    await rejects(store.save('ok-1234', { name: 'x', board: 'b1' }, { '../A.ino': '' }, null));
    await rejects(store.load('Bad Id'));
  });
  t('github: a build\'s result and .bin are read once the workflow writes them', async () => {
    const { gs, store } = await seeded();
    const r = await store.save('fan-ab12', { name: 'Fan', board: 'b1' }, { 'Fan.ino': 'void setup() {}\nvoid loop() {}\n' }, null);
    eq(await store.result('fan-ab12', r.commit), null, 'nothing yet');
    const bin = new Uint8Array(3000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) & 255;
    await gs.putFiles([{ path: 'builds/fan-ab12/' + r.commit + '.json', text: JSON.stringify({ format: 'jig.build/1', ok: true, commit: r.commit }) },
      { path: 'builds/fan-ab12/' + r.commit + '.bin', bytes: bin }], { message: 'Jig: build' });
    eq((await store.result('fan-ab12', r.commit)).ok, true);
    const got = await store.binary('fan-ab12', r.commit);
    eq(got.length, 3000); eq(got[2999], (2999 * 7) & 255);
    const p = await store.load('fan-ab12');
    eq(p.build.commit, r.commit, 'a build commit that only touched builds/ doesn\'t move the project\'s last commit'); ok(p.build.result && p.build.result.ok);
  });

  // ── Build stages from GitHub's Actions API (the step names and times of the first real build, 2026-11-20) ──
  const step = (name, status, a, b, conclusion) => ({ name, status, started_at: a, completed_at: b, conclusion: conclusion || (status === 'completed' ? 'success' : null) });
  const T = s => '2026-11-20T03:' + s + 'Z';
  const runOf = st => ({ id: 1, head_sha: 'beb74e08', status: st, created_at: T('20:42') });
  const planJob = { name: 'plan', status: 'completed', conclusion: 'success', started_at: T('20:44'), completed_at: T('20:49'), steps: [] };
  const buildJob = (status, buildStep) => ({ name: 'build', status, started_at: T('20:51'), completed_at: status === 'completed' ? T('22:28') : null,
    conclusion: status === 'completed' ? 'success' : null,
    steps: [step('Set up job', 'completed', T('20:52'), T('20:52')), step('Install the core', 'completed', T('20:55'), T('21:39')), buildStep] });
  t('stages: queued, then tools, compiling, and saving, with their times', () => {
    const S = JIG.store.stagesFrom, st = xs => xs.map(x => x.key + ':' + x.state).join(' ');
    eq(st(S(null, [])), 'queue:now tools:todo compile:todo publish:todo', 'no run yet');
    eq(st(S(runOf('queued'), [Object.assign({}, planJob, { status: 'in_progress', conclusion: null })])), 'queue:now tools:todo compile:todo publish:todo');
    eq(st(S(runOf('in_progress'), [planJob, buildJob('in_progress', step('Build', 'pending'))])), 'queue:done tools:now compile:todo publish:todo');
    const compiling = S(runOf('in_progress'), [planJob, buildJob('in_progress', step('Build', 'in_progress', T('21:40')))]);
    eq(st(compiling), 'queue:done tools:done compile:now publish:todo');
    eq([compiling[0].start, compiling[0].end, compiling[1].end, compiling[2].start], [T('20:42'), T('20:51'), T('21:40'), T('21:40')]);
    const done = S(runOf('completed'), [planJob, buildJob('completed', step('Build', 'completed', T('21:40'), T('22:13'))),
      { name: 'publish', status: 'completed', conclusion: 'success', started_at: T('22:31'), completed_at: T('22:38'), steps: [] }]);
    eq(st(done), 'queue:done tools:done compile:done publish:done');
    eq((Date.parse(done[2].end) - Date.parse(done[2].start)) / 1000, 33, 'compiling took 33 s');
    eq(st(S(runOf('completed'), [planJob, buildJob('completed', step('Build', 'completed', T('21:40'), T('22:13'), 'failure'))])), 'queue:done tools:done compile:failed publish:todo');
  });

  // ── The demo store ──
  t('demo store: save builds in the background, and a failed build has no .bin', async () => {
    try { localStorage.removeItem('jig.demo.v1'); } catch (e) { /* blocked */ }
    const s = JIG.store.DemoJig();
    const ix = await s.open();
    eq(ix.projects.length, 2);
    const p = await s.load('room-temp-p2x7');
    const r = await s.save('room-temp-p2x7', p.meta, p.files, p.shas);
    ok(r.commit, 'a never-built project builds even unchanged');
    for (let i = 0; i < 50 && !(await s.result('room-temp-p2x7', r.commit)); i++) await new Promise(res => setTimeout(res, 100));
    const res = await s.result('room-temp-p2x7', r.commit);
    eq(res.ok, false); eq(res.messages[0].line, 15);
    await rejects(s.binary('room-temp-p2x7', r.commit));
    s.reset();
  });

  for (const [name, fn] of tests) {
    try { await fn(); out.push('ok   ' + name); }
    catch (e) { fails.push(name); out.push('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  out.unshift((fails.length ? 'FAIL' : 'PASS') + ': ' + (tests.length - fails.length) + ' of ' + tests.length + ' tests');
  document.getElementById('out').textContent = out.join('\n');
  document.title = fails.length ? 'FAIL' : 'PASS';
})().catch(e => { document.getElementById('out').textContent = 'ERROR ' + (e && e.stack || e); document.title = 'ERROR'; });
