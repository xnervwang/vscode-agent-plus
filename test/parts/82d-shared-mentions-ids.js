// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Session ids that are not UUIDs, such as OpenCode's ses_ ids, in the mention matcher of shared/page/kit.js: which of
 * them the list given to mentionIndex() makes it look for, where a whole one is linked, and that a list of UUIDs alone
 * gives the same links as before.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const kit = require(path.join(root, 'shared', 'page', 'kit.js'));
  const CC = 'claude-code', OC = 'opencode';
  const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const A = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6', B = 'ses_df3c28ab2ffe1QWERTYuiopAS2';
  const cc = (n, title) => ({ sourceId: CC, sessionId: uuid(n), title, lastActiveAt: n * 1000, label: 'Claude Code', cwd: '/w' });
  const oc = (sessionId, title, at = 5000) => ({ sourceId: OC, sessionId, title, lastActiveAt: at, label: 'OpenCode', cwd: '/w' });
  const SELF = { sourceId: CC, sessionId: uuid(99) };
  const find = (text, known, opts, self = SELF) => kit.mentions(text, kit.mentionIndex(known, self), opts)
    .map((r) => [text.slice(r.start, r.end), r.kind, r.sourceId, r.sessionId]);
  const known = [cc(1, 'Fix the login redirect'), cc(2, 'Second one here'), oc(A, 'Port the parser'), oc(B, 'Docs')];

  eq([find(`see ${A}, and 看一下${B}的进度`, known), find(`(${A}). Then ${B}.`, known)],
    [[[A, 'id', OC, A], [B, 'id', OC, B]], [[A, 'id', OC, A], [B, 'id', OC, B]]],
    'an id that is not a UUID is linked where it stands whole: after a space, next to CJK text, in brackets, before a full stop');
  eq([find(A.toUpperCase(), known), find(A.toLowerCase(), known), find(uuid(1).toUpperCase(), known)],
    [[], [], [[uuid(1).toUpperCase(), 'id', CC, uuid(1)]]],
    'such an id matches only as it is written, while a UUID still matches in any case');
  eq([find(`x${A} ${A}x ${A}_2 ${A}-x ${A.slice(0, -1)} ${A.slice(0, 8)}`, known)], [[]],
    'it never matches inside a longer run of letters, digits, _ or -, nor by its first 8 characters or another part of it');
  eq(find(`~/.local/share/opencode/storage/session/${A}/x, ${A}.json, C:\\w\\${B}, ${B}/ and ${A}.*`, known), [],
    'an id that is part of a path, next to a slash or followed by a file extension, is not linked');
  eq(find('short ses_abc, odd ses:abc12345 and abc12345, then long-enough',
    known.concat([oc('ses_abc', 'Seven'), oc('ses:abc12345', 'Colon'), oc('long-enough', 'Eleven')])),
  [['long-enough', 'id', OC, 'long-enough']],
  'only an id of 8 to 200 letters, digits, _ or - is looked for: one of 7 characters or one with a colon is not');
  eq(find(`${A} and ses_df3c28ab2ffe9ZZZZZZZZZZZZZ`, [cc(1, 'Fix the login redirect')]), [],
    'an id that is in no conversation of the list is not linked');
  eq(find('ok 0123abcd here', [oc('0123abcd', 'Hex like')]).map((r) => r[0]), ['0123abcd'],
    'an id of 8 hex digits that is not a UUID is linked once');

  eq([find(`${A} and ${B}`, known, {}, { sourceId: OC, sessionId: A }), find(`${A}`, known, {}, { sourceId: CC, sessionId: A })],
    [[[B, 'id', OC, B]], [[A, 'id', OC, A]]],
    'the conversation\'s own id is never linked, and a conversation of another agent with the same id is not the conversation itself');
  eq(find(`Port the parser in ${A}`, known, { idsOnly: true }), [[A, 'id', OC, A]], 'in inline code the id is linked and the title is not');
  eq(find(`Review ${A} output`, known.concat([cc(3, `Review ${A} output`)])), [[`Review ${A} output`, 'title', CC, uuid(3)]],
    'where a title holds the id, the title is longer and is the one linked');

  {
    const [r] = kit.mentions(`see ${A}`, kit.mentionIndex(known, SELF));
    eq(kit.mentionTip(r, 5000 + 60000).split('\n'), ['Port the parser', 'OpenCode conversation ses_df3c, active 1m ago'],
      'its hover label names the conversation, its agent and the first 8 characters of its id');
  }

  {
    const uuids = known.filter((c) => c.sourceId === CC);
    const text = `See Fix the login redirect, ${uuid(2)}, ${uuid(1).slice(0, 8)}, 「Second one here」 and \`${uuid(1)}\`.`;
    eq([find(text, known), find(text, known, { idsOnly: true })], [find(text, uuids), find(text, uuids, { idsOnly: true })],
      'with ids of another form in the list, the titles and the UUIDs of a text are linked just as with the UUIDs alone');
  }

  {
    const t = (value) => ({ type: 'text', value });
    const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
    const tree = { type: 'root', children: [
      el('p', [t(`See ${A} and `), el('code', [t(`run ${B}`)])]),
      el('pre', [el('code', [t(A)])]),
      el('p', [el('a', [t(A)], { href: 'https://x' })]),
    ] };
    const make = (r, text) => el('a', [t(text)], { href: `open:${r.sourceId}` });
    const made = kit.linkMentionsTree(tree, kit.mentionIndex(known, SELF), make);
    const flat = (n) => (n.type === 'text' ? n.value : `<${n.tagName}${n.properties.href ? ' ' + n.properties.href : ''}`
      + `${n.properties.dataAgentPlusMention ? ' ' + n.properties.dataAgentPlusMention : ''}>` + n.children.map(flat).join('') + `</${n.tagName}>`);
    eq([made, tree.children.map(flat)], [2, [
      `<p>See <a open:opencode opencode:${A}>${A}</a> and <code>run <a open:opencode opencode:${B}>${B}</a></code></p>`,
      `<pre><code>${A}</code></pre>`, `<p><a https://x>${A}</a></p>`]],
    'in a HAST tree such an id is linked in text and in inline code, not in a code block or a link, and the link is marked with its source and id');
  }
};
