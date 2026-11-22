// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Opening a conversation through a source (src/views.js): a window whose source says it shows the conversation, through
 * `shows`, takes another window's request; when no window has it, a source with `openHere` is offered Open it here.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const viewOptions = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 300, attentionMs: 20 };
  const S = '01a20228-9021-7920-a3bf-466905cf47ea';
  {
    const b = boot(root, tmp, { viewOptions });
    const revealed = [], here = [];
    b.control.state.answers.push(['is not open in any VS Code window', 'Open it here']);
    b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', features: ['openHere'], listConversations: async () => [],
      reveal: async (id) => { revealed.push(id); return false; }, openHere: async (id, row) => { here.push([id, row.title]); return true; } });
    await wait(60);
    await b.control.state.handlers['agentPlus.openConversation']({ sourceId: 'codex', sessionId: S, title: 'Galaxy', cwd: '/w' });
    for (let i = 0; i < 100 && !here.length; i++) await wait(20);
    eq([revealed, b.control.state.said.filter((m) => /not open in any/.test(m.message)).map((m) => [m.message, m.buttons]), here],
      [[S], [['"Galaxy" is not open in any VS Code window on this machine.', ['Open it here']]], [[S, 'Galaxy']]],
      'when no window has the conversation, a source with openHere is offered Open it here, and the pick opens it in this window');
    b.close();
  }
  {
    const b = boot(root, tmp, { viewOptions });
    const revealed = [];
    b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', features: ['shows'], listConversations: async () => [],
      shows: (id) => id === S, reveal: async (id) => { revealed.push(id); return true; } });
    await wait(60);
    const dir = path.join(b.home, 'open');
    fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now().toString(36)}-0badcafe`;
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ format: 1, at: Date.now(), from: 'other-00000000', sourceId: 'codex',
      sessionId: S, title: 'Galaxy', cwd: '/w' }));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, id + '.done')); i++) await wait(20);
    eq([fs.existsSync(path.join(dir, id + '.done')), revealed], [true, [S]],
      'a window whose source shows the conversation outside a tab takes another window\'s request to open it, and reveals it there');
    b.close();
  }
};
