// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Edges of the mention matcher in shared/page/kit.js: corner brackets nested or left open, one title named twice, a
 * title written across two text nodes, and the hover label of a title many conversations share.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const kit = require(path.join(root, 'shared', 'page', 'kit.js'));
  const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const conv = (n, title, over) => Object.assign({ sourceId: 'claude-code', sessionId: id(n), title, lastActiveAt: n * 1000, label: 'Claude Code' }, over);
  const ix = (known) => kit.mentionIndex(known, { sourceId: 'claude-code', sessionId: id(99) });
  const find = (text, known) => kit.mentions(text, ix(known)).map((r) => [text.slice(r.start, r.end), r.kind]);
  const LQ = '「', RQ = '」';

  eq([find(`${LQ}a ${LQ}Docs${RQ}`, [conv(1, 'Docs')]), find(`${LQ}Docs and more`, [conv(1, 'Docs')]), find(`${LQ}${LQ}Docs${RQ}${RQ}`, [conv(1, 'Docs')])],
    [[['Docs', 'quoted']], [], [['Docs', 'quoted']]],
    'a bracket left open does not swallow the next one, an unclosed one matches nothing, and nested brackets match the inner title');
  eq(find('Fix the login redirect, then Fix the login redirect again', [conv(1, 'Fix the login redirect')]),
    [['Fix the login redirect', 'title'], ['Fix the login redirect', 'title']], 'a title named twice is linked twice');
  {
    const t = (value) => ({ type: 'text', value });
    const tree = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [t('Fix the login '),
      { type: 'element', tagName: 'strong', properties: {}, children: [t('redirect')] }]}] };
    eq(kit.linkMentionsTree(tree, ix([conv(1, 'Fix the login redirect')]), () => ({ type: 'element', tagName: 'a', properties: {}, children: [] })), 0,
      'a title split across two text nodes, as by bold on part of it, is not matched');
  }
  {
    const known = [1, 2, 3, 4, 5, 6].map((n) => conv(n, 'One shared title'));
    const [r] = kit.mentions('One shared title', ix(known));
    const tip = kit.mentionTip(r, 6000 + 60000).split('\n');
    eq([r.sessionId, r.others.length, tip[2]], [id(6), 5,
      '5 other conversations have this title: Claude Code 00000005, active 1m ago; Claude Code 00000004, active 1m ago; Claude Code 00000003, active 1m ago; and 2 more'],
    'of six conversations with one title the newest is linked, and its label names three of the others and counts the rest');
  }
};
