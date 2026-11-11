// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * plan-row.py moving closed rows out of the plan file and back, and the core reading the plan with them.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { readPlanAt } = require('../../src/workplan');

const AGENTS = ['claude', 'codex'];
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

module.exports = async ({ eq, note, tmp, root }) => {
  const shared = path.join(root, 'shared', 'plugin');
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the row command was not run'); return; }
  const now = Date.now() / 1000;
  const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
  const DAY = 86400;
  const original = () => ({ nodes: [
    { title: 'Old and closed ' + 'x'.repeat(100), state: 'done', opened: iso(now - 9 * DAY), since: iso(now - 3 * DAY), closed: iso(now - 3 * DAY),
      note: 'kept in the archive', detail: 'all of it', children: [
        { title: 'Old child', state: 'dropped', since: iso(now - 4 * DAY), closed: iso(now - 4 * DAY), children: [] }] },
    { title: 'Closed over an open child', state: 'done', closed: iso(now - 3 * DAY), children: [{ title: 'Open', state: 'todo' }] },
    { title: 'Closed an hour ago', state: 'done', closed: iso(now - 3600) },
    { title: 'Open parent', state: 'todo', children: [
      { title: 'Open sibling', state: 'todo' },
      { title: 'Old closed child', state: 'dropped', closed: iso(now - 5 * DAY), note: 'why it was dropped' }] },
    { title: 'Closed with no time', state: 'done' },
    { title: 'Last', state: 'todo' },
  ] });
  for (const agent of AGENTS) {
    const hooks = path.join(tmp(`archive-hooks-${agent}`), 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(hooks, 'plan_agent.py'));
    const fresh = (name) => {
      const data = tmp(`archive-${agent}-${name}`);
      const file = path.join(data, SID + '.json');
      fs.writeFileSync(file, JSON.stringify(original(), null, 2));
      const closed = path.join(data, 'closed', SID + '.json');
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
      return { data, file, closed, main: () => read(file), archive: () => read(closed) };
    };
    const row = (p, ...args) => cp.spawnSync(python, ['-B', path.join(hooks, 'plan-row.py'), p.file, ...args],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const rowsOf = (a) => (a && Array.isArray(a.nodes) ? a.nodes.map((n) => n.row).sort() : null);

    /* ── What is moved, and what is left ── */
    {
      const p = fresh('moved');
      const r = row(p, 'set', '6', '--note', 'touched');
      const m = p.main();
      eq([r.status, m.nodes.length, m.nodes[0], m.nodes[1].children.length, m.nodes[2].state, m.nodes[2].archived,
        m.nodes[3].children[1], m.nodes[4].archived, m.nodes[5].note],
      [0, 6, { title: 'Old and closed ' + 'x'.repeat(64) + '…', state: 'done', archived: true }, 1, 'done', undefined,
        { title: 'Old closed child', state: 'dropped', archived: true }, undefined, 'touched'],
      `${agent}: a write moves each whole closed subtree closed more than a day ago and leaves a placeholder with its state and `
        + 'a title cut to 80; a closed row over an open one, one closed an hour ago and one with no time stay');
      const a = p.archive();
      const first = a && a.nodes.find((n) => n.row === '1');
      eq([rowsOf(a), first && first.note, first && first.children.length, first && first.children[0].title],
        [['1', '4.2'], 'kept in the archive', 1, 'Old child'],
        `${agent}: the moved rows are in closed/<session id>.json with everything they had, each saying which row it was`);
      const inj = cp.spawnSync(python, ['-B', path.join(hooks, 'inject-work-plan.py'), p.data],
        { input: JSON.stringify({ session_id: SID, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
      let text = '';
      try { text = JSON.parse(inj.stdout).hookSpecificOutput.additionalContext; } catch (_) { /* none */ }
      eq([/o 6\. Last/.test(text), /o 4\.1\. Open sibling/.test(text), /o 2\.1\. Open/.test(text)], [true, true, true],
        `${agent}: the numbers of the rows after a placeholder are what they were`);
    }

    /* ── Moving back ── */
    {
      const p = fresh('back');
      row(p, 'set', '6', '--note', 'x');
      const r = row(p, 'set', '1', 'todo');
      const m = p.main();
      eq([r.status, m.nodes[0].state, m.nodes[0].archived, m.nodes[0].title, m.nodes[0].detail, m.nodes[0].children[0],
        rowsOf(p.archive())],
      [0, 'todo', undefined, 'Old and closed ' + 'x'.repeat(100), 'all of it', { title: 'Old child', state: 'dropped', archived: true },
        ['1.1', '4.2']],
      `${agent}: setting an archived row to an open state puts it back in the plan, and its closed child, old enough on its own, `
        + 'goes to the archive in its place');
    }
    {
      const p = fresh('child');
      row(p, 'set', '6', '--note', 'x');
      const r = row(p, 'set', '1.1', 'todo');
      const m = p.main();
      eq([r.status, m.nodes[0].archived, m.nodes[0].children[0].state, rowsOf(p.archive())], [0, undefined, 'todo', ['4.2']],
        `${agent}: changing a row under an archived one puts its archived ancestor back first`);
    }
    {
      const p = fresh('under');
      row(p, 'set', '6', '--note', 'x');
      const r = row(p, 'add', 'todo', 'New child', '--under', '1.1');
      const m = p.main();
      eq([r.status, m.nodes[0].archived, m.nodes[0].children[0].children.map((c) => c.title), rowsOf(p.archive())],
        [0, undefined, ['New child'], ['4.2']], `${agent}: adding a row under an archived one puts it back first`);
    }
    {
      const p = fresh('note');
      row(p, 'set', '6', '--note', 'x');
      const r = row(p, 'set', '4.2', '--note', 'a better reason');
      const m = p.main();
      const back = (p.archive() || { nodes: [] }).nodes.find((n) => n.row === '4.2');
      eq([r.status, m.nodes[3].children[1].archived, back && back.note], [0, true, 'a better reason'],
        `${agent}: a change that leaves an archived row closed goes into the archive, and the row stays there`);
    }

    /* ── After a compaction ── */
    {
      const p = fresh('resume');
      const said = () => {
        const r = cp.spawnSync(python, ['-B', path.join(hooks, 'resume-work-plan.py'), p.data],
          { input: JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source: 'compact' }), encoding: 'utf8' });
        try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return ''; }
      };
      const before = said();
      row(p, 'set', '6', '--note', 'x');
      const after = said();
      eq([before.includes(p.closed), after.includes(p.closed), /placeholder/.test(after)], [false, true, true],
        `${agent}: once rows have been moved, the note after a compaction says where the closed rows went`);
    }

    /* ── The core reads both files ── */
    {
      const p = fresh('read');
      const before = readPlanAt(p.file, SID);
      row(p, 'set', '6', '--note', 'touched');
      const after = readPlanAt(p.file, SID);
      before.nodes[5].note = 'touched';
      eq(JSON.stringify(after.nodes), JSON.stringify(before.nodes),
        `${agent}: the core reads the plan and its closed rows into the same rows it read before they were moved`);
      fs.rmSync(path.join(p.data, 'closed'), { recursive: true, force: true });
      const alone = readPlanAt(p.file, SID);
      eq([alone.error, alone.nodes[0].title, alone.nodes[0].state, alone.nodes[0].children.length], ['',
        'Old and closed ' + 'x'.repeat(64) + '…', 'done', 0],
      `${agent}: without the archive a placeholder reads as a closed row with its title cut short`);
    }
  }
};
