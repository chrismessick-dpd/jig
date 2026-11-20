// Jig's demo (?demo): the made-up Smart Thermostat's Main PCBA for Acme Climate, a few sketches kept in this
// browser, and a simulated build. Nothing here is a real board or real firmware.
//
//   JIG.demo.boards, .projects(), .examples       the starting data
//   JIG.demo.check(files, main)                   the simulated compiler's messages for a sketch
//   JIG.demo.binary(files)                        made-up firmware bytes for a passing build
(function (JIG) {
  'use strict';
  const boards = {
    // flasher: the board's id in Flasher's demo (its Smart Thermostat Main PCBA), so Flash opens it there.
    'thermostat-main': { name: 'Main PCBA (Smart Thermostat)', fqbn: 'acme:stm32:thermostat_main', flasher: 'tstat-main',
      flashMax: 131072, ramMax: 32768 }
  };

  const BLINK = [
    '// Blinks the status LED once a second.',
    '#include <Thermostat.h>',
    '',
    'const int blinkMs = 500;',
    '',
    'void setup() {',
    '  pinMode(STATUS_LED, OUTPUT);',
    '}',
    '',
    'void loop() {',
    '  digitalWrite(STATUS_LED, HIGH);',
    '  delay(blinkMs);',
    '  digitalWrite(STATUS_LED, LOW);',
    '  delay(blinkMs);',
    '}',
    ''
  ].join('\n');
  const TEMP = [
    '// Reads the room thermistor and prints the temperature every 2 s.',
    '#include <Thermostat.h>',
    '',
    'void setup() {',
    '  Serial.begin(115200);',
    '  analogReadResolution(12);',
    '}',
    '',
    'void loop() {',
    '  int raw = analogRead(ROOM_NTC);',
    '  float c = thermistorCelsius(raw);   // from Thermostat.h',
    '  Serial.print("Room: ");',
    '  Serial.print(c, 1);',
    '  Serial.println(" C");',
    '  delay(2000);',
    '}',
    ''
  ].join('\n');
  const RELAY = [
    '// Steps through the heat and cool relays, 3 s each, for a bench check.',
    '#include <Thermostat.h>',
    '#include "pins.h"',
    '',
    'void setup() {',
    '  pinMode(HEAT_RELAY, OUTPUT);',
    '  pinMode(COOL_RELAY, OUTPUT);',
    '}',
    '',
    'void loop() {',
    '  pulse(HEAT_RELAY);',
    '  pulse(COOL_RELAY);',
    '}',
    '',
    'void pulse(int pin) {',
    '  digitalWrite(pin, HIGH);',
    '  delay(ON_MS);',
    '  digitalWrite(pin, LOW);',
    '  delay(1000);',
    '}',
    ''
  ].join('\n');
  const PINS = '// The bench check\'s timing.\n#pragma once\n\n#define ON_MS 3000\n';

  const examples = {
    'thermostat-main': [
      { name: 'Blink', files: { 'Blink.ino': BLINK } },
      { name: 'RoomTemperature', files: { 'RoomTemperature.ino': TEMP } },
      { name: 'RelayCheck', files: { 'RelayCheck.ino': RELAY, 'pins.h': PINS } }
    ]
  };

  function projects() {
    const at = new Date(Date.now() - 3 * 86400000).toISOString();
    return {
      'status-led-k3m9': { id: 'status-led-k3m9', name: 'Status LED blink', board: 'thermostat-main', createdAt: at, createdBy: 'demo visitor',
        updatedAt: at, updatedBy: 'demo visitor', files: { 'Blink.ino': BLINK } },
      'room-temp-p2x7': { id: 'room-temp-p2x7', name: 'Room temperature', board: 'thermostat-main', createdAt: at, createdBy: 'demo visitor',
        updatedAt: at, updatedBy: 'demo visitor', files: { 'RoomTemperature.ino': TEMP.replace('delay(2000);', 'delay(2000)') } }
    };
  }

  // The simulated compiler: unbalanced brackets, a missing semicolon after a call, #error, and a missing
  // setup() or loop(). Comments and strings are skipped, as a compiler would.
  function check(files, main) {
    const msgs = [];
    const add = (file, line, col, text, severity) => msgs.push({ file, line, col, severity: severity || 'error', text });
    for (const name of Object.keys(files).sort()) {
      const text = files[name], stack = [];
      let line = 1, col = 1;
      for (const [cls, s] of JIG.cpp.tokens(text)) {
        if (cls === 'pp' && /^#\s*error\b/.test(s)) add(name, line, col, s.replace(/^#\s*error\s*/, '#error ') || '#error');
        if (!cls) {
          for (const ch of s) {
            if ('({['.includes(ch)) stack.push({ ch, line, col });
            else if (')}]'.includes(ch)) {
              const want = { ')': '(', '}': '{', ']': '[' }[ch], top = stack.pop();
              if (!top) add(name, line, col, "expected declaration before '" + ch + "' token");
              else if (top.ch !== want) add(name, line, col, "expected '" + { '(': ')', '{': '}', '[': ']' }[top.ch] + "' before '" + ch + "' token");
            }
            if (ch === '\n') { line++; col = 1; } else col++;
          }
        } else {
          for (const ch of s) { if (ch === '\n') { line++; col = 1; } else col++; }
        }
      }
      for (const open of stack) add(name, open.line, open.col, "expected '" + { '(': ')', '{': '}', '[': ']' }[open.ch] + "' at end of input");
      // A statement line that ends in ')' inside a function body, with the next line starting a new statement.
      const ls = text.split('\n');
      ls.forEach((l, k) => {
        const code = l.replace(/\/\/.*$/, '').trimEnd();
        if (/^\s+[A-Za-z_][\w.]*\s*\(.*\)$/.test(code) && !/^\s*(if|for|while|switch)\b/.test(code)) {
          const next = (ls.slice(k + 1).find(x => x.trim()) || '').trim();
          if (next && !next.startsWith('{') && !next.startsWith('.')) add(name, k + 1, code.length + 1, "expected ';' before '" + next.split(/\s/)[0].replace(/[^\w}]+$/, '') + "'");
        }
      });
    }
    const m = files[main] || '';
    const code = JIG.cpp.tokens(m).filter(t => t[0] !== 'com' && t[0] !== 'str').map(t => t[1]).join('');
    if (!/\bvoid\s+setup\s*\(/.test(code)) add(main, null, null, "undefined reference to 'setup'");
    if (!/\bvoid\s+loop\s*\(/.test(code)) add(main, null, null, "undefined reference to 'loop'");
    return msgs;
  }

  function binary(files) {
    const text = Object.keys(files).sort().map(k => k + '\n' + files[k]).join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const n = 18432 + text.length * 12 - (text.length * 12) % 4, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; out[i] = h & 0xff; }
    // A Cortex-M vector table, so Flasher's checks take it: the stack at the top of the board's 32 KB of RAM, and an
    // odd (Thumb) reset vector inside the image.
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x20008000, true);
    dv.setUint32(4, 0x08000000 + 0x1c1, true);
    return out;
  }

  JIG.demo = { boards, projects, examples, check, binary };
})(window.JIG = window.JIG || {});
