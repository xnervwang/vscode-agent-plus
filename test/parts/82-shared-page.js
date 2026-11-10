// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * shared/page/kit.js, the small pieces both page scripts use: run under Node, where it is also a module, and with a
 * stand-in AudioContext and document for the chime and the hover label.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = async ({ eq, root, wait }) => {
  const file = path.join(root, 'shared', 'page', 'kit.js');
  const text = fs.readFileSync(file, 'utf8');
  eq([/[^\x00-\x7f]/.test(text), /=>|`|\b(let|const|class)\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))], [false, false],
    'the kit is ASCII and ES5, as the page scripts it goes into are');
  const kit = require(file);
  const now = new Date(2026, 10, 9, 12, 0, 0).getTime();
  eq([kit.age(now, now), kit.age(now - 61e3, now), kit.age(now - 3 * 3600e3, now), kit.age(now - 40 * 86400e3, now), kit.age(now - 400 * 86400e3, now)],
    ['now', '1m', '3h', '1mo', '1y'], 'how long ago is floored, as Claude Code\'s own list writes it');
  const day = (y, m, d) => new Date(y, m - 1, d, 9).getTime();
  eq([kit.span(day(2026, 11, 5), day(2026, 11, 9), now), kit.span(day(2026, 11, 9), day(2026, 11, 9), now),
    kit.span(day(2025, 11, 5), day(2025, 11, 9), now), kit.span(day(2025, 12, 30), day(2026, 1, 2), now), kit.span(0, 0, now)],
  ['11/05→11/09', '11/09', '2025/11/05→11/09', '2025/12/30→01/02', ''],
  'a span is month before day, one date for one day, and another year written once in front');
  const today = new Date(); today.setHours(8, 5, 7, 0);
  eq([kit.stamp(today.getTime()), kit.stamp(today.getTime(), false), /^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$|^\d{4}\/\d{2}\/\d{2} /.test(kit.stamp(today.getTime() - 3 * 86400e3))],
    ['08:05:07', '08:05', true], 'a time today is the clock alone, another day goes in front');
  eq([kit.kfmt(999), kit.kfmt(1234), kit.kfmt(2500000), kit.kfmt(NaN), kit.pct(0, 10), kit.pct(0.001, 10), kit.pct(5, 10), kit.pct(1, 0)],
    ['999', '1.2k', '2.5M', '-', '0.0%', '<0.1%', '50.0%', ''], 'figures and shares');

  {
    const told = [];
    const page = vm.createContext({ setTimeout, Promise });
    page.globalThis = page;
    page.AudioContext = function () { this.state = 'suspended'; this.currentTime = 0; this.resume = () => new Promise(() => {}); };
    vm.runInContext(text, page);
    page.agentPlusKit.chime('question', (kind, state) => told.push([kind, state]));
    await wait(350);
    eq(told, [['question', 'suspended']], 'a chime whose context the browser will not resume is dropped after 300 ms, and says so');
    const played = [];
    page.AudioContext = function () {
      this.state = 'running'; this.currentTime = 1; this.destination = {};
      this.createOscillator = () => ({ frequency: { setValueAtTime: (hz, at) => played.push([hz, +at.toFixed(2)]) }, connect() {}, start() {}, stop() {} });
      this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
    };
    vm.runInContext(text, page);
    page.agentPlusKit.chime('approval', () => {});
    eq(played, [[880, 1.01], [880, 1.14], [880, 1.27]], 'a permission is three equal notes, under either name the pages give it');
  }

  {
    const made = [];
    const el = (rect) => ({ rect, attrs: {}, style: {}, listeners: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(k, f) { this.listeners[k] = f; },
      getBoundingClientRect() { return this.rect; } });
    const page = vm.createContext({});
    page.globalThis = page;
    page.innerWidth = 400;
    page.document = { body: { appendChild(b) { b.parentNode = this; made.push(b); }, removeChild(b) { b.parentNode = null; } },
      createElement: () => Object.assign(el({ width: 100, height: 30 }), { style: {} }) };
    vm.runInContext(text, page);
    const tips = page.agentPlusKit.labels({ mark: ['data-x', 'label'], css: 'z-index:9;' });
    const low = el({ top: 300, bottom: 320, left: 380, width: 20, height: 20 });
    tips.wire(low, 'Says what it does', 'data-x-labelled');
    low.listeners.mouseenter();
    const box = tips.current();
    eq([box.textContent, box.attrs['data-x'], box.style.top, box.style.left, /z-index:9;/.test(box.style.cssText)],
      ['Says what it does', 'label', '262px', '292px', true], 'a label goes above its control, kept 8px inside the window');
    low.listeners.click();
    eq([tips.current(), box.parentNode], [null, null], 'and goes on click');
    const high = el({ top: 4, bottom: 24, left: 10, width: 20, height: 20 });
    tips.show(high, 'Near the top');
    eq([tips.current().style.top, tips.current().style.left], ['32px', '8px'], 'with no room above it goes below');
  }
};
