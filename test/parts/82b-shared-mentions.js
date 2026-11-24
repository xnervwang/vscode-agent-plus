// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The mention matcher of shared/page/kit.js: which text names another conversation, and how the two walkers put a link
 * in its place, in a DOM subtree and in a HAST tree.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const kit = require(path.join(root, 'shared', 'page', 'kit.js'));
  const marks = require(path.join(root, 'src', 'title-marks.js'));
  const CC = 'claude-code';
  const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const conv = (n, title, over) => Object.assign({ sourceId: CC, sessionId: id(n), title, lastActiveAt: n * 1000, label: 'Claude Code', cwd: '/w' }, over);
  const SELF = { sourceId: CC, sessionId: id(99) };
  const ixOf = (known, self = SELF) => kit.mentionIndex(known, self);
  const find = (text, known, opts, self) => kit.mentions(text, ixOf(known, self), opts).map((r) => [text.slice(r.start, r.end), r.kind, r.sessionId.slice(0, 8)]);
  const BLACK = '黑盒测试 ADV和 AUV';
  const TEST = '测试', LQ = '「', RQ = '」';

  {
    const inputs = ['\u{1F451} Steward', 'Plain ✉️', 'a \u{1F6CE}️ b  c', 'none', ' ✉︎ ', ''];
    eq(inputs.map((t) => kit.withoutMarks(t)), inputs.map((t) => marks.withoutMarks(t)), 'marks are taken off a title the same way src/title-marks.js does');
  }

  eq([find(`${LQ}Docs${RQ} and ${LQ}Doc${RQ}`, [conv(1, 'Docs'), conv(2, 'Doc')]),
    find(`${LQ}${TEST}${RQ} and ${LQ}测${RQ}`, [conv(3, TEST), conv(4, '测')])],
  [[['Docs', 'quoted', '00000001']], [[TEST, 'quoted', '00000003']]],
  'in corner brackets a title matches from 4 characters, or 2 CJK characters');
  eq([find('Docs and 测试 alone', [conv(1, 'Docs'), conv(3, TEST)]),
    find('see Fix redirect now', [conv(5, 'Fix redirect')]), find('see Fix redir now', [conv(5, 'Fix redir')])],
  [[], [['Fix redirect', 'title', '00000005']], []],
  'standing on its own a title needs a width of 10: Docs or two CJK characters never, Fix redirect (12) yes, Fix redir (9) no');
  eq([find(`看一下${BLACK}的进度`, [conv(6, BLACK)]), find('黑盒测试报告', [conv(7, '黑盒测试报')]),
    find('黑盒测试', [conv(8, '黑盒测试')])],
  [[[BLACK, 'title', '00000006']], [['黑盒测试报', 'title', '00000007']], []],
  'a CJK character counts 2 towards that width, and CJK text right next to a title does not stop the match');
  eq([find('xFix redirect', [conv(5, 'Fix redirect')]), find('Fix redirects', [conv(5, 'Fix redirect')]), find('Fix redirect2', [conv(5, 'Fix redirect')]),
    find('(Fix redirect).', [conv(5, 'Fix redirect')]), find('caféFix redirect', [conv(5, 'Fix redirect')])],
  [[], [], [], [['Fix redirect', 'title', '00000005']], []],
  'a title on its own may not touch a letter or digit on either side; punctuation is fine');
  eq(find(`${LQ}(untitled)${RQ}, ${LQ}New chat${RQ}, New session, ${LQ}Untitled${RQ}`, [conv(1, '(untitled)'), conv(2, 'New chat'), conv(3, 'New session'), conv(4, 'Untitled')]),
    [], 'placeholder titles never match');

  {
    const known = [conv(1, 'Alpha one two three'), conv(2, 'Beta'), conv(0xabcdef12, 'Gamma')];
    known[2].sessionId = 'abcdef12-1111-4222-8333-444455556666';
    eq([find(`ids ${id(1).toUpperCase()} and ${id(2)}x and x${id(2)}`, known), find(`short ${id(1).slice(0, 8)}, abcdef12; not abcdef123 nor 0abcdef12`, known)],
      [[[id(1).toUpperCase(), 'id', '00000001']], [['00000001', 'short', '00000001'], ['abcdef12', 'short', 'abcdef12']]],
      'a whole session id matches in any case, and its first 8 characters on their own, never inside a longer run');
    eq([find(`Alpha one two three in ${id(2)}`, known, { idsOnly: true })], [[[id(2), 'id', '00000002']]], 'in inline code only ids are looked for');
    eq(find(`~/.claude/scratch/x/${id(1)}/run, ${id(1)}.jsonl, C:\\w\\${id(2)}, 00000001/a, b/00000002 and plan 00000001.json`, known), [],
      'an id that is part of a path, next to a slash or followed by a file extension, is not linked');
    eq(find(`See ${id(1)}. Then 00000002.`, known), [[id(1), 'id', '00000001'], ['00000002', 'short', '00000002']],
      'a full stop after an id ends the sentence, not a file name');
    const twins = [conv(1, 'Shared title'), { sourceId: CC, sessionId: '00000001-ffff-4000-8000-000000000000', title: 'Other' }];
    eq(find('00000001', twins), [], 'a short id that starts two known ids matches neither');
  }

  eq(find(`${LQ}Fix the login redirect${RQ}, Fix the login redirect page`, [conv(1, 'Fix the login'), conv(2, 'Fix the login redirect'), conv(3, 'login redirect page')]),
    [['Fix the login redirect', 'quoted', '00000002'], ['Fix the login redirect', 'title', '00000002']],
    'where two titles overlap, only the longer one matches');

  {
    const known = [conv(1, 'My own title here'), conv(2, 'My own title here'), conv(3, 'Somebody else'), Object.assign(conv(99, 'My own title here'))];
    eq([find(`${id(99)}, ${id(99).slice(0, 8)}, ${LQ}My own title here${RQ}, Somebody else`, known)],
      [[['Somebody else', 'title', '00000003']]],
      'the conversation\'s own id, short id and title are never linked, nor another conversation that has its title');
    eq(find('My own title here', [conv(1, 'My own title here')], {}, { sourceId: CC, sessionId: id(99), title: '\u{1F451} My own title here' }), [],
      'its title is left out when the caller gives it, too, marks and all');
    eq(find(`${LQ}Somebody else${RQ}`, [conv(3, 'Somebody else'), conv(99, 'x', { sourceId: 'codex' })], {}).length, 1,
      'a conversation of another agent with the same session id is not the conversation itself');
  }

  {
    const known = [conv(1, 'Fix the login redirect', { label: 'Claude Code' }), conv(7, 'Fix the login redirect', { sourceId: 'codex', label: 'Codex' }),
      conv(3, 'Fix the login redirect')];
    const [r] = kit.mentions('Fix the login redirect', ixOf(known));
    eq([r.sourceId, r.sessionId, r.label, r.others.map((o) => o.sessionId.slice(0, 8))], ['codex', id(7), 'Codex', ['00000003', '00000001']],
      'of several conversations with one title, the most recently active is linked and the others are listed with it');
    eq(kit.mentionTip(r, 7000 + 120000).split('\n'), ['Fix the login redirect', 'Codex conversation 00000007, active 2m ago',
      '2 other conversations have this title: Claude Code 00000003, active 2m ago; Claude Code 00000001, active 2m ago'],
    'its label names the conversation, its agent, when it was last active, and the others with that title');
    eq([find(`${LQ}Steward talk${RQ}`, [conv(4, '\u{1F451} Steward talk')]), find(`${LQ}\u{1F451} Steward talk${RQ}`, [conv(4, 'Steward talk')])],
      [[['Steward talk', 'quoted', '00000004']], [['\u{1F451} Steward talk', 'quoted', '00000004']]],
      'titles are compared without the marks drawn with them, on either side');
  }

  /* The HAST walker, over the tree react-markdown renders. */
  {
    const known = [conv(1, 'Fix the login redirect'), conv(2, 'Second one here')];
    const ix = ixOf(known);
    const t = (value) => ({ type: 'text', value });
    const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
    const tree = { type: 'root', children: [
      el('p', [t('See Fix the login redirect and '), el('code', [t(`Second one here ${id(2)}`)]), t(' then.')]),
      el('pre', [el('code', [t('Fix the login redirect')])]),
      el('p', [el('a', [t('Fix the login redirect')], { href: 'https://x' }), el('strong', [t(`${LQ}Second one here${RQ}`)])]),
    ] };
    const make = (r, text) => el('a', [t(text)], { href: `open:${r.sessionId.slice(0, 8)}` });
    const made = kit.linkMentionsTree(tree, ix, make);
    const flat = (n) => (n.type === 'text' ? n.value : `<${n.tagName}${n.properties.href ? ' ' + n.properties.href : ''}${n.properties.dataAgentPlusMention ? ' *' : ''}>`
      + n.children.map(flat).join('') + `</${n.tagName}>`);
    eq([made, tree.children.map(flat)], [3, [
      `<p>See <a open:00000001 *>Fix the login redirect</a> and <code>Second one here <a open:00000002 *>${id(2)}</a></code> then.</p>`,
      '<pre><code>Fix the login redirect</code></pre>',
      `<p><a https://x>Fix the login redirect</a><strong>${LQ}<a open:00000002 *>Second one here</a>${RQ}</strong></p>`]],
    'in a HAST tree: a code block and a link are left alone, inline code gets only its id linked, and each link made is marked');
    eq(kit.linkMentionsTree(tree, ix, make), 0, 'run again over the same tree it adds no more links');
    eq(kit.linkMentionsTree(el('pre', [t('Fix the login redirect')]), ix, make), 0, 'given a code block itself, it adds no link');
  }

  /* The DOM walker, over a stand-in document. */
  {
    const doc = { createTextNode: (v) => node(3, '#text', v), createElement: (name) => node(1, name.toUpperCase()) };
    function node(type, name, value) {
      const n = { nodeType: type, nodeName: name, nodeValue: value === undefined ? null : value, childNodes: [], parentNode: null, attrs: {}, ownerDocument: doc,
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
        insertBefore(c, ref) { c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; },
        removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; },
        closest(sel) {
          const tags = sel.split(',').map((s) => s.trim());
          for (let at = this; at; at = at.parentNode) {
            if (at.nodeType !== 1) continue;
            for (const s of tags) {
              if (s === at.nodeName.toLowerCase()) return at;
              const m = /^\[([\w-]+)\](?::not\(.*\))?$/.exec(s);
              if (m && at.getAttribute(m[1]) !== null && !(m[1] === 'contenteditable' && at.getAttribute(m[1]) === 'false')) return at;
            }
          }
          return null;
        } };
      return n;
    }
    const h = (name, kids, attrs) => { const n = node(1, name.toUpperCase()); for (const k of kids) n.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k); Object.assign(n.attrs, attrs || {}); return n; };
    const html = (n) => (n.nodeType === 3 ? n.nodeValue : `<${n.nodeName.toLowerCase()}${n.attrs.href ? ' ' + n.attrs.href : ''}${n.getAttribute(kit.MENTION_ATTR) !== null ? ' *' : ''}>`
      + n.childNodes.map(html).join('') + `</${n.nodeName.toLowerCase()}>`);
    const known = [conv(1, 'Fix the login redirect'), conv(2, 'Second one here')];
    const ix = ixOf(known);
    const body = h('div', [
      h('p', ['Fix the login redirect, and ', h('code', [`run ${id(1)}`]), '.']),
      h('pre', ['Fix the login redirect']),
      h('textarea', ['Fix the login redirect']), h('input', []), h('div', ['Fix the login redirect'], { contenteditable: 'true' }),
      h('div', ['Second one here'], { contenteditable: 'false' }),
    ]);
    const make = (r, text) => { const a = doc.createElement('a'); a.setAttribute('href', 'open:' + r.sessionId.slice(0, 8)); a.appendChild(doc.createTextNode(text)); return a; };
    const made = kit.linkMentions(body, ix, make);
    eq([made, body.childNodes.map(html)], [3, [
      `<p><a open:00000001 *>Fix the login redirect</a>, and <code>run <a open:00000001 *>${id(1)}</a></code>.</p>`,
      '<pre>Fix the login redirect</pre>', '<textarea>Fix the login redirect</textarea>', '<input></input>',
      '<div>Fix the login redirect</div>', '<div><a open:00000002 *>Second one here</a></div>']],
    'in the DOM: a code block, a text field and editable text are left alone, inline code gets only its id linked');
    eq([kit.linkMentions(body, ix, make), kit.linkMentions(body.childNodes[0].childNodes[0], ix, make), kit.linkMentions(body.childNodes[1], ix, make)], [0, 0, 0],
      'called again, on the same subtree, on a link it made or on a code block, it adds no link');
    const p = h('p', [h('code', [`${id(2)} and Second one here`])]);
    h('div', [p]);
    eq([kit.linkMentions(p.childNodes[0], ix, make), html(p)], [1, `<p><code><a open:00000002 *>${id(2)}</a> and Second one here</code></p>`],
      'called on inline code itself, it still links only the id');
    eq(kit.linkMentions(body, kit.mentionIndex([], SELF), make), 0, 'with no conversation known it does nothing');
  }
};
