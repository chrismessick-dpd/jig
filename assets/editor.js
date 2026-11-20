// Jig's editor: a text box over a highlighted copy of its text, with line numbers and marks on the lines the
// last build flagged (docs/design.md, *The page*). Small on purpose: the pages allow only this site's scripts,
// so a bigger editor (CodeMirror) would have to be bundled in; this can be swapped for one later.
//
//   JIG.cpp.tokens(text)            [[cls, text], …]: com, str, num, kw, type, pp, ard, fn, or '' (plain)
//   JIG.cpp.lines(text)             the text as highlighted HTML, one string per line
//   JIG.editor.create(host, opts)   opts: { onChange(text), onSave() }
//     .value() / .set(text)         read, or replace (which starts a fresh undo history)
//     .marks([{ line, col, severity, text }])   flag lines (1-based); [] clears
//     .go(line, col)                put the caret there and scroll it into view
//     .focus()
(function (JIG) {
  'use strict';
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const KW = new Set(('alignas alignof and asm auto break case catch class const constexpr const_cast continue decltype default delete do ' +
    'dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept not nullptr operator or ' +
    'private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this throw ' +
    'true try typedef typeid typename union using virtual volatile while').split(' '));
  const TYPES = new Set(('bool boolean byte char double float int long short signed unsigned void word size_t String ' +
    'int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t').split(' '));
  // Arduino's own names, shown apart so a reader sees what comes from the core.
  const ARD = new Set(('setup loop pinMode digitalWrite digitalRead analogRead analogWrite analogReadResolution analogWriteResolution ' +
    'delay delayMicroseconds millis micros attachInterrupt detachInterrupt interrupts noInterrupts tone noTone pulseIn shiftOut shiftIn ' +
    'map constrain min max abs random randomSeed bitRead bitWrite bitSet bitClear Serial Serial1 Serial2 Wire SPI ' +
    'HIGH LOW INPUT OUTPUT INPUT_PULLUP INPUT_PULLDOWN LED_BUILTIN CHANGE RISING FALLING').split(' '));

  function tokens(text) {
    const out = [], n = text.length;
    let i = 0, lineStart = true;
    const push = (cls, s) => { if (s) out.push([cls, s]); };
    while (i < n) {
      const c = text[i], d = text[i + 1];
      if (c === '/' && d === '/') { let j = text.indexOf('\n', i); if (j < 0) j = n; push('com', text.slice(i, j)); i = j; continue; }
      if (c === '/' && d === '*') { let j = text.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('com', text.slice(i, j)); i = j; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        j = Math.min(n, j + (text[j] === c ? 1 : 0));
        push('str', text.slice(i, j)); i = j; lineStart = false; continue;
      }
      if (c === '#' && lineStart) {
        // A preprocessor line, up to a comment; an #include's <file> is a string.
        let j = i; while (j < n && text[j] !== '\n' && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++;
        const line = text.slice(i, j), m = /^(#\s*include\s*)(<[^>]*>?)(.*)$/.exec(line);
        if (m) { push('pp', m[1]); push('str', m[2]); push('', m[3]); } else push('pp', line);
        i = j; lineStart = false; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
        const m = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|[0-9][0-9']*\.?[0-9']*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)[uUlLfF]*/.exec(text.slice(i, i + 64));
        push('num', m[0]); i += m[0].length; lineStart = false; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 256))[0];
        let k = i + m.length; while (text[k] === ' ' || text[k] === '\t') k++;
        push(KW.has(m) ? 'kw' : TYPES.has(m) ? 'type' : ARD.has(m) ? 'ard' : text[k] === '(' ? 'fn' : '', m);
        i += m.length; lineStart = false; continue;
      }
      if (c === '\n') { lineStart = true; push('', c); i++; continue; }
      if (c !== ' ' && c !== '\t') lineStart = false;
      // Plain text runs to the next character that could start something else.
      let j = i + 1;
      while (j < n && !/[\/"'#0-9A-Za-z_\n.]/.test(text[j])) j++;
      push('', text.slice(i, j)); i = j;
    }
    return out;
  }

  // Highlighted HTML per line; a token that spans lines (a block comment) is split at each newline.
  function lines(text) {
    const out = [''];
    for (const [cls, s] of tokens(text)) {
      const parts = s.split('\n');
      parts.forEach((p, k) => {
        if (k > 0) out.push('');
        if (p) out[out.length - 1] += cls ? '<span class="t-' + cls + '">' + esc(p) + '</span>' : esc(p);
      });
    }
    return out;
  }
  JIG.cpp = { tokens, lines };

  function create(host, opts) {
    opts = opts || {};
    host.classList.add('jg-ed');
    host.innerHTML = '<div class="jg-gutter" aria-hidden="true"><div class="jg-gutter-in"></div></div>' +
      '<div class="jg-code"><div class="jg-hl" aria-hidden="true"></div>' +
      '<textarea class="jg-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Sketch text"></textarea></div>';
    const ta = host.querySelector('.jg-ta'), hl = host.querySelector('.jg-hl'), gut = host.querySelector('.jg-gutter-in');
    let marks = [];

    function draw() {
      const ls = lines(ta.value), byLine = {};
      for (const m of marks) {
        const cur = byLine[m.line];
        if (!cur || (m.severity === 'error' && cur.severity !== 'error')) byLine[m.line] = m;
      }
      const tip = n => marks.filter(m => m.line === n).map(m => (m.severity === 'error' ? '✕ ' : '▲ ') + m.text).join('\n');
      hl.innerHTML = ls.map((h, k) => {
        const m = byLine[k + 1];
        return '<div class="jg-l' + (m ? (m.severity === 'error' ? ' is-err' : ' is-warn') : '') + '">' + (h || ' ') + '</div>';
      }).join('');
      gut.innerHTML = ls.map((_, k) => {
        const m = byLine[k + 1];
        return '<div class="jg-n' + (m ? (m.severity === 'error' ? ' is-err' : ' is-warn') : '') + '"' + (m ? ' title="' + esc(tip(k + 1)).replace(/"/g, '&quot;') + '"' : '') + '>' +
          (m ? '<span class="jg-n-mark">' + (m.severity === 'error' ? '✕' : '▲') + '</span>' : '') + (k + 1) + '</div>';
      }).join('');
      scroll();
    }
    function scroll() {
      hl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
      gut.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    }
    // Typing through insertText keeps the text box's own undo history.
    function insert(s) {
      if (!document.execCommand || !document.execCommand('insertText', false, s)) {
        const a = ta.selectionStart, b = ta.selectionEnd;
        ta.setRangeText(s, a, b, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
    function lineRange() {
      const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      const s = v.lastIndexOf('\n', a - 1) + 1;
      let e = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b); if (e < 0) e = v.length;
      return [s, e];
    }
    function indentLines(out) {
      const [s, e] = lineRange(), block = ta.value.slice(s, e);
      const next = block.split('\n').map(l => out ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l).join('\n');
      ta.setSelectionRange(s, e); insert(next); ta.setSelectionRange(s, s + next.length);
    }
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (opts.onSave) opts.onSave(); return; }
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (e.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentLines(e.shiftKey);
        else insert('  ');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
        e.preventDefault();
        const v = ta.value, a = ta.selectionStart, s = v.lastIndexOf('\n', a - 1) + 1;
        const ind = /^[ \t]*/.exec(v.slice(s, a))[0], before = v.slice(s, a).trimEnd(), after = v.slice(ta.selectionEnd);
        if (before.endsWith('{') && /^\s*\}/.test(after.split('\n')[0])) {
          insert('\n' + ind + '  \n' + ind); const p = ta.selectionStart - ind.length - 1; ta.setSelectionRange(p, p);
        } else insert('\n' + ind + (before.endsWith('{') ? '  ' : ''));
        return;
      }
      if (e.key === '}' && !e.ctrlKey && !e.metaKey) {
        // A closing brace on an indented, otherwise empty line steps back one level.
        const v = ta.value, a = ta.selectionStart, s = v.lastIndexOf('\n', a - 1) + 1, pre = v.slice(s, a);
        if (/^ {2,}$/.test(pre) && a === ta.selectionEnd) { e.preventDefault(); ta.setSelectionRange(a - 2, a); insert('}'); }
      }
    });
    ta.addEventListener('input', () => { draw(); if (opts.onChange) opts.onChange(ta.value); });
    ta.addEventListener('scroll', scroll);

    return {
      el: ta,
      value: () => ta.value,
      set(text) { ta.value = text || ''; ta.scrollTop = 0; ta.scrollLeft = 0; draw(); },
      marks(list) { marks = (list || []).filter(m => m.line > 0); draw(); },
      go(line, col) {
        const ls = ta.value.split('\n'); line = Math.max(1, Math.min(ls.length, line || 1));
        let p = 0; for (let k = 0; k < line - 1; k++) p += ls[k].length + 1;
        p += Math.max(0, Math.min(ls[line - 1].length, (col || 1) - 1));
        ta.focus(); ta.setSelectionRange(p, p);
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
        const top = (line - 1) * lh;
        if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 2 * lh) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
        scroll();
      },
      focus: () => ta.focus()
    };
  }
  JIG.editor = { create };
})(window.JIG = window.JIG || {});
