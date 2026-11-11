// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Counts what the work plan's injection costs on this machine and how well the plans are kept, over the last N days
 * (14 by default) or since a given time. Only counts and lengths are printed; no text from a transcript or a plan.
 *
 *   node build/plan-injection-stats.js [--days N | --since ISO-TIME] [--claude-home DIR] [--codex-home DIR] [--json]
 *
 * Run it before a change to the injection and again some days after it, with --since set to when the new version was
 * installed, and compare the two. It reads Claude Code's transcripts (<claude home>/projects/<project>/<session>.jsonl,
 * main threads only) and Codex's rollouts (<codex home>/sessions and archived_sessions), and the plans beside each
 * agent's plugin data directory. It is not part of the extension: build/ is not packed.
 *
 * What is counted, and how each thing is recognised:
 *
 *   injection   Claude Code: an attachment of type hook_additional_context with hookEvent UserPromptSubmit, one
 *               string of whose content starts with "This conversation's work plan". The time zone hook uses the same
 *               event and is told apart by that prefix. A string starting "<persisted-output>" whose preview holds the
 *               prefix is an injection Claude Code saved to a file because it was over 10,000 characters; the model saw
 *               only that string, so its length is what is counted, and the size the string gives is kept apart as
 *               `persistedOriginalChars`. An attachment whose uuid already appeared in the same file is counted once.
 *               Codex: a developer message, one of whose input_text items starts with the prefix. Lengths are
 *               JavaScript string lengths, which is how Claude Code measures a hook's output.
 *   since compaction   Only injections after the conversation's last compaction (Claude Code: a system row with subtype
 *               compact_boundary; Codex: a row of type compacted) count towards what is in the current context.
 *   unchanged   An injection whose text equals the one before it in the same conversation once durations ("for 3h",
 *               "written 5m ago") and a persisted file's path are taken out. `unchangedChars` is what those came to.
 *   opening     A conversation's first injection in the window, and the first after each compaction: the turns that get
 *               the whole block.
 *   turn        From an injection to the next injection, the next message the user typed, or (Codex) the next
 *               task_started, whichever comes first. A message queued while a turn runs gets an injection of its own, so
 *               it starts a turn here. Turns without an injection (no plan, or nothing open in it) are not counted.
 *   working turn   A turn with at least one tool call that is not to the plan. A call to the plan is a shell command
 *               that names a plan file (under agent-work-plan-*-extras), Codex's work_plan MCP tools, or a Read, Write or
 *               Edit of a plan file. A shell command running plan-row.py on some other file, as when the plugin itself is
 *               being worked on, is ordinary work.
 *   changing turn  A turn with at least two calls that changed something, judged the way shared/plugin/hooks/changes.py
 *               judges them (nudgeMinChanges defaults to 2).
 *   kept by the agent   A working turn in which, before the first end-of-turn reminder of that turn, the agent wrote a
 *               row: plan-row.py set or add on the plan (also through a variable holding the command, `$R set 3 done`),
 *               Codex's set_row or add_row, a Write or Edit of the plan file, or another shell command that names the
 *               plan file and changes something (changes.py). Writing the brief (summary, status) is not a row.
 *               `keptStrict` also requires the write to come before any other plan reminder in the turn (the one when
 *               work starts with nothing doing, and the context watermark).
 *   end-of-turn reminder   A Stop hook's text from nudge-work-plan.py about rows: "This turn changed" (the plan was not
 *               reconciled), "This turn is ending with" (rows still doing), "Your last reply may be asking" (a question
 *               not on a row). The brief's requests are counted on their own. Claude Code records them as Stop
 *               hook_additional_context; Codex as a hook_prompt.
 *   stale doing   As build/plan-health.js in Codex Plus counts them: `doing` rows in plans written in the window whose
 *               conversation is not running a turn now. Here "not running" is a transcript or rollout not written for two
 *               hours (Codex Plus's STALE_WORKING_MS), which needs neither agent's binary.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_DAYS = 14;
const PREFIX = "This conversation's work plan";
const PERSISTED = '<persisted-output>';
const STALE_MS = 2 * 60 * 60 * 1000;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_FILE = /agent-work-plan-[a-z-]+-extras[\\/]+[0-9a-f][0-9a-f-]{7,}\.json\b/;
/* A row command's `set ROW` or `add STATE`, also when the command line is kept in a variable (`$R set 3 done`). */
const ROW_WRITE = /(?:^|[\s;&|("'])(?:set\s+\d+(?:\.\d+)*|add\s+(?:discussing|todo|doing|waiting|parked|done|dropped))\b/;
const ROW_TOOLS = ['set_row', 'add_row'];
const PLAN_TOOLS = ['set_row', 'add_row', 'set_summary', 'set_status', 'set_wakeup'];
const NUDGES = { reconcile: 'This turn changed ', settle: 'This turn is ending with ', question: 'Your last reply may be asking' };
const BRIEF_ASKS = ['The summary of this conversation', 'This turn did work, and the status'];
const REMIND = 'This turn has started working, and no row';
const WATERMARK = /^The context (?:has passed|is) [\d,]+ tokens/;

/* changes.py, ported: whether a tool call changed something. */
const CHANGING_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'apply_patch'];
const SHELL_TOOLS = ['Bash', 'exec_command', 'shell', 'local_shell'];
const CHANGING_SHELL = new RegExp(
  '\\bgit\\s+(commit|add|push|mv|rm|apply|checkout|reset|revert|tag|stash)\\b'
  + '|\\b(tee|mkdir|rmdir|touch|mv|cp|rm|chmod|chown|ln|truncate|install)\\s'
  + '|\\bsed\\s+-i'
  + '|(?:^|(?<=[\\s|;&]))\\d?>>?\\s*(?![\\d&=(-]|/dev/)[^\\s|;&]', 'm');
const WRITING_OPEN = new RegExp(
  '\\bopen\\(\\s*(?:[^,()\'"]|\'[^\']*\'|"[^"]*"|\\([^()]*\\))+,\\s*(?:mode\\s*=\\s*)?[\'"][^\'"]*[wax]'
  + '|\\bopen\\([^)]*\\bmode\\s*=\\s*[\'"][^\'"]*[wax]'
  + '|\\.open\\(\\s*(?:mode\\s*=\\s*)?[\'"][^\'"]*[wax]');
const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

function shellWords(command) {
  const out = [];
  let pos = 0;
  for (;;) {
    HEREDOC.lastIndex = pos;
    const m = HEREDOC.exec(command);
    if (!m) { out.push(command.slice(pos)); break; }
    out.push(command.slice(pos, m.index + m[0].length));
    const end = new RegExp('^[ \\t]*' + m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*$', 'mg');
    end.lastIndex = m.index + m[0].length;
    const e = end.exec(command);
    if (!e) break;
    pos = e.index + e[0].length;
  }
  return out.join('').replace(QUOTED, 'Q');
}

function shellCommand(input) {
  let given = input;
  if (typeof given === 'string') {
    try { given = JSON.parse(given); } catch (_) { return given; }
  }
  if (!given || typeof given !== 'object') return '';
  const command = given.command !== undefined ? given.command : given.cmd;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return typeof command === 'string' ? command : '';
}

function changes(name, input) {
  if (CHANGING_TOOLS.includes(name)) return true;
  if (!SHELL_TOOLS.includes(name)) return false;
  const command = shellCommand(input);
  return Boolean(command) && (CHANGING_SHELL.test(shellWords(command)) || WRITING_OPEN.test(command));
}

/* How a call relates to the plan: 'row' (writes a row), 'plan' (any other use of the plan), or '' (none). */
function planCall(name, input, namespace) {
  if (namespace === 'mcp__work_plan' || (!namespace && PLAN_TOOLS.includes(name) && /"plan"/.test(JSON.stringify(input || '')))) {
    return ROW_TOOLS.includes(name) ? 'row' : 'plan';
  }
  if (SHELL_TOOLS.includes(name)) {
    const command = shellCommand(input);
    if (!PLAN_FILE.test(command)) return '';
    if (command.includes('plan-row.py')) return ROW_WRITE.test(command) ? 'row' : 'plan';
    return changes(name, input) ? 'row' : 'plan';
  }
  const file = input && typeof input === 'object' ? String(input.file_path || input.path || '') : '';
  if (file && PLAN_FILE.test(file)) return name === 'Read' ? 'plan' : 'row';
  if (name === 'apply_patch' && PLAN_FILE.test(String(typeof input === 'string' ? input : JSON.stringify(input || '')))) return 'row';
  return '';
}

/* An injection's text with what changes on every turn taken out. */
function normalised(text) {
  return text.replace(/Full output saved to: [^\n]*/, '').replace(/ for \d+[mhd]\b/g, '').replace(/ written \d+[mhd] ago/g, ' written');
}

function originalChars(text) {
  const m = /Output too large \(([\d.]+)(KB|MB)\)/.exec(text);
  return m ? Math.round(Number(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : 1024)) : null;
}

const pct = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const spread = (xs) => ({ n: xs.length, sum: xs.reduce((a, b) => a + b, 0), median: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: xs.length ? Math.max(...xs) : null });
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

function emptyTally() {
  return { files: 0, conversations: 0, injections: [], persisted: 0, persistedOriginalChars: [], unchanged: 0, unchangedChars: 0,
    opening: 0, openingChars: 0, compactions: 0,
    perConversation: [], perConversationSinceCompaction: [], perConversationCount: [], turns: 0, working: 0,
    changing: 0, kept: 0, keptStrict: 0, keptChanging: 0, nudged: 0, nudgedChanging: 0,
    nudgeKinds: { reconcile: 0, settle: 0, question: 0 }, briefAsks: 0, reminded: 0, watermarks: 0 };
}

/* One conversation's file. `kind` is 'claude' or 'codex'. */
async function scan(file, kind, since, tally) {
  const conv = { injections: 0, chars: 0, sinceCompaction: 0, last: null, opening: true };
  let turn = null;
  const close = () => {
    if (!turn) return;
    tally.turns++;
    if (turn.work) tally.working++;
    if (turn.changed >= 2) tally.changing++;
    if (turn.work && turn.keptAt !== null && (turn.nudgeAt === null || turn.keptAt < turn.nudgeAt)) {
      tally.kept++;
      if (turn.changed >= 2) tally.keptChanging++;
      if (turn.promptAt === null || turn.keptAt < turn.promptAt) tally.keptStrict++;
    }
    if (turn.work && turn.nudgeAt !== null) tally.nudged++;
    if (turn.changed >= 2 && turn.nudgeAt !== null) tally.nudgedChanging++;
    turn = null;
  };
  let seq = 0;
  const seen = new Set();
  const inject = (text, at) => {
    close();
    if (at !== null && at < since) { conv.last = normalised(text); return; }
    tally.injections.push(text.length);
    if (text.startsWith(PERSISTED)) {
      tally.persisted++;
      const o = originalChars(text);
      if (o !== null) tally.persistedOriginalChars.push(o);
    }
    const norm = normalised(text);
    if (conv.last !== null && norm === conv.last) { tally.unchanged++; tally.unchangedChars += text.length; }
    if (conv.opening) { tally.opening++; tally.openingChars += text.length; conv.opening = false; }
    conv.last = norm;
    conv.injections++;
    conv.chars += text.length;
    conv.sinceCompaction += text.length;
    turn = { work: false, changed: 0, keptAt: null, nudgeAt: null, promptAt: null };
  };
  const call = (name, input, namespace) => {
    if (!turn) return;
    seq++;
    const p = planCall(name, input, namespace);
    if (!p) {
      turn.work = true;
      if (changes(name, input)) turn.changed++;
    } else if (p === 'row' && turn.keptAt === null) {
      turn.keptAt = seq;
    }
  };
  const reminder = (text) => {
    if (!turn) return;
    seq++;
    for (const part of text.split(/\n\n+/)) {
      let hit = false;
      for (const [k, prefix] of Object.entries(NUDGES)) {
        if (part.startsWith(prefix)) { tally.nudgeKinds[k]++; hit = true; }
      }
      if (hit && turn.nudgeAt === null) turn.nudgeAt = seq;
      if (hit && turn.promptAt === null) turn.promptAt = seq;
      if (BRIEF_ASKS.some((b) => part.startsWith(b))) tally.briefAsks++;
    }
  };
  const prompt = (text) => {
    if (!turn) return;
    seq++;
    if (text.startsWith(REMIND)) tally.reminded++;
    else if (WATERMARK.test(text)) tally.watermarks++;
    else return;
    if (turn.promptAt === null) turn.promptAt = seq;
  };

  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (kind === 'claude') {
      if (line.includes('"hook_additional_context"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        const a = r && r.attachment;
        if (!a || a.type !== 'hook_additional_context') continue;
        if (r.uuid && seen.has(r.uuid)) continue;
        if (r.uuid) seen.add(r.uuid);
        const at = Date.parse(r.timestamp || '');
        for (const s of Array.isArray(a.content) ? a.content.map(String) : [String(a.content || '')]) {
          if (a.hookEvent === 'UserPromptSubmit') {
            if (s.startsWith(PREFIX) || (s.startsWith(PERSISTED) && s.includes('\n' + PREFIX))) inject(s, Number.isFinite(at) ? at : null);
          } else if (a.hookEvent === 'Stop') {
            reminder(s);
          } else if (a.hookEvent === 'PostToolBatch' || a.hookEvent === 'PostToolUse') {
            prompt(s);
          }
        }
      } else if (line.includes('"compact_boundary"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if (r && r.type === 'system' && r.subtype === 'compact_boundary') {
          conv.sinceCompaction = 0;
          conv.opening = true;
          if (Date.parse(r.timestamp || '') >= since) tally.compactions++;
        }
      } else if (turn && line.includes('"tool_use"') && line.includes('"assistant"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        const content = r && r.type === 'assistant' && r.message && r.message.content;
        for (const b of Array.isArray(content) ? content : []) if (b && b.type === 'tool_use') call(b.name || '', b.input, '');
      } else if (turn && line.includes('"user"') && !line.includes('"tool_use_id"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if (spoke(r)) close();
      }
    } else {
      if (line.includes('"task_started"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if (r && r.type === 'event_msg' && r.payload && r.payload.type === 'task_started') close();
        continue;
      }
      if (line.startsWith('{"timestamp"') && line.includes('"type":"compacted"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if (r && r.type === 'compacted') {
          conv.sinceCompaction = 0;
          conv.opening = true;
          if (Date.parse(r.timestamp || '') >= since) tally.compactions++;
        }
        continue;
      }
      if (line.includes('"hook_prompt"')) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if (r && r.type !== 'compacted') reminder(hookPromptText(r));
        continue;
      }
      if (line.includes('"developer"') && (line.includes(PREFIX) || line.includes(REMIND) || line.includes('The context has passed'))) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        const p = r && r.type === 'response_item' && r.payload;
        if (!p || p.type !== 'message' || p.role !== 'developer') continue;
        const at = Date.parse(r.timestamp || '');
        for (const c of Array.isArray(p.content) ? p.content : []) {
          const s = String((c && c.text) || '');
          if (s.startsWith(PREFIX)) inject(s, Number.isFinite(at) ? at : null);
          else prompt(s);
        }
        continue;
      }
      if (turn && (line.includes('"function_call"') || line.includes('"custom_tool_call"'))) {
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        const p = r && r.type === 'response_item' && r.payload;
        if (!p) continue;
        if (p.type === 'function_call') call(String(p.name || ''), p.arguments, String(p.namespace || ''));
        else if (p.type === 'custom_tool_call') call(String(p.name || ''), p.input, String(p.namespace || ''));
      }
    }
  }
  close();
  if (conv.injections) {
    tally.conversations++;
    tally.perConversation.push(conv.chars);
    tally.perConversationSinceCompaction.push(conv.sinceCompaction);
    tally.perConversationCount.push(conv.injections);
  }
}

/* The text of a Codex hook_prompt row, wherever in the row it is. */
function hookPromptText(row) {
  const texts = [];
  const walk = (v) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(row.payload);
  return texts.filter((t) => Object.values(NUDGES).some((n) => t.includes(n)) || BRIEF_ASKS.some((b) => t.includes(b))).join('\n\n');
}

/* A user row that is a message typed by the user (plan_agent.py's spoke() for Claude Code). */
function spoke(row) {
  if (!row || row.type !== 'user' || row.isMeta || row.isCompactSummary) return false;
  let content = row.message && row.message.content;
  if (Array.isArray(content)) {
    const texts = content.filter((b) => b && b.type === 'text').map((b) => String(b.text || ''));
    if (!texts.length) return false;
    content = texts.join('');
  }
  return typeof content === 'string' && !content.trimStart().startsWith('[Request interrupted');
}

function listFiles(dir, test, depth) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...listFiles(p, test, depth - 1));
    else if (e.isFile() && test(e.name)) out.push(p);
  }
  return out;
}

function mtime(file) { try { return fs.statSync(file).mtimeMs; } catch (_) { return null; } }

/* Rows and text in a plan: how much of it the closed rows are, and its `doing` rows. */
function planShape(plan) {
  const out = { rows: 0, closedRows: 0, placeholders: 0, chars: 0, closedChars: 0, doing: [] };
  const walk = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || typeof n !== 'object') continue;
      out.rows++;
      if (n.archived === true) out.placeholders++;
      const own = { ...n }; delete own.children;
      const len = JSON.stringify(own).length;
      out.chars += len;
      if (n.state === 'done' || n.state === 'dropped') { out.closedRows++; out.closedChars += len; }
      if (n.state === 'doing') out.doing.push(n.since);
      walk(n.children);
    }
  };
  walk(plan && plan.nodes);
  return out;
}

function health(dir, transcriptOf, since, now) {
  const out = { plans: 0, rows: 0, doing: 0, doingRunning: 0, doingIdle: 0, doingUnknown: 0, doingIdleOverDay: 0,
    doingIdleOverWeek: 0, doingIdleMedianHours: null, planBytes: [], closedShare: [], archivedPlaceholders: 0 };
  const hours = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && SESSION.test(n.slice(0, -5))); } catch (_) { /* no plans */ }
  for (const name of names) {
    const file = path.join(dir, name);
    let plan, size;
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < since) continue;
      size = st.size;
      plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { continue; }
    out.plans++;
    out.planBytes.push(size);
    const shape = planShape(plan);
    out.rows += shape.rows;
    out.archivedPlaceholders += shape.placeholders;
    if (shape.chars) out.closedShare.push(Math.round((shape.closedChars / shape.chars) * 1000) / 1000);
    if (!shape.doing.length) continue;
    out.doing += shape.doing.length;
    const t = transcriptOf(name.slice(0, -5));
    const touched = t ? mtime(t) : null;
    if (touched === null) { out.doingUnknown += shape.doing.length; continue; }
    if (now - touched < STALE_MS) { out.doingRunning += shape.doing.length; continue; }
    out.doingIdle += shape.doing.length;
    for (const s of shape.doing) {
      const at = Date.parse(s || '');
      if (!Number.isFinite(at)) continue;
      const h = (now - at) / 3600e3;
      hours.push(h);
      if (h > 24) out.doingIdleOverDay++;
      if (h > 168) out.doingIdleOverWeek++;
    }
  }
  out.doingIdleMedianHours = hours.length ? Math.round(pct(hours, 0.5) * 10) / 10 : null;
  out.planBytes = spread(out.planBytes);
  out.closedShare = { n: out.closedShare.length, median: pct(out.closedShare, 0.5), p90: pct(out.closedShare, 0.9) };
  return out;
}

function summarise(t) {
  const persisted = t.persistedOriginalChars;
  return {
    files: t.files, conversationsWithInjection: t.conversations,
    injections: { ...spread(t.injections), persisted: t.persisted, persistedOriginalChars: spread(persisted),
      unchanged: t.unchanged, unchangedShare: ratio(t.unchanged, t.injections.length), unchangedChars: t.unchangedChars,
      opening: t.opening, openingChars: t.openingChars, compactions: t.compactions },
    perConversation: { chars: spread(t.perConversation), charsSinceCompaction: spread(t.perConversationSinceCompaction),
      injections: spread(t.perConversationCount) },
    turns: { injected: t.turns, working: t.working, changing: t.changing, kept: t.kept, keptStrict: t.keptStrict,
      keptChanging: t.keptChanging, nudged: t.nudged, nudgedChanging: t.nudgedChanging, nudgeKinds: t.nudgeKinds,
      briefAsks: t.briefAsks, remindedMidTurn: t.reminded, watermarks: t.watermarks },
    rates: { keptOfWorking: ratio(t.kept, t.working), keptStrictOfWorking: ratio(t.keptStrict, t.working),
      keptOfChanging: ratio(t.keptChanging, t.changing), nudgedOfWorking: ratio(t.nudged, t.working),
      nudgedOfChanging: ratio(t.nudgedChanging, t.changing) },
  };
}

async function measure({ now = Date.now(), days = DEFAULT_DAYS, since = '', claudeHome = '', codexHome = '' } = {}) {
  const from = since ? Date.parse(since) : now - (Number(days) || DEFAULT_DAYS) * 86400e3;
  if (!Number.isFinite(from)) throw new Error('--since is not a time: ' + since);
  const claude = claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codex = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const transcripts = listFiles(path.join(claude, 'projects'), (n) => n.endsWith('.jsonl') && SESSION.test(n.slice(0, -6)), 1);
  const bySession = new Map(transcripts.map((f) => [path.basename(f, '.jsonl'), f]));
  const rollouts = [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions')]
    .flatMap((d) => listFiles(d, (n) => /^rollout-.*\.jsonl$/.test(n), 4));
  const byThread = new Map();
  for (const f of rollouts) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(f);
    if (m && (!byThread.has(m[1]) || mtime(f) > mtime(byThread.get(m[1])))) byThread.set(m[1], f);
  }

  const out = { window: { since: new Date(from).toISOString(), until: new Date(now).toISOString() } };
  for (const [kind, files] of [['claude', transcripts], ['codex', rollouts]]) {
    const tally = emptyTally();
    for (const f of files) {
      const touched = mtime(f);
      if (touched === null || touched < from) continue;
      tally.files++;
      await scan(f, kind, from, tally);
    }
    out[kind] = summarise(tally);
  }
  out.claude.planHealth = health(path.join(claude, 'plugins', 'data', 'agent-work-plan-claude-code-extras'),
    (s) => bySession.get(s), from, now);
  out.codex.planHealth = health(path.join(codex, 'plugins', 'data', 'agent-work-plan-codex-extras'),
    (s) => byThread.get(s), from, now);
  return out;
}

function report(r) {
  const lines = [`window: ${r.window.since} to ${r.window.until}`];
  for (const kind of ['claude', 'codex']) {
    const k = r[kind];
    const i = k.injections;
    lines.push('', `${kind}: ${k.files} files read, ${k.conversationsWithInjection} with a plan injection`,
      `  injections: ${i.n}, median ${i.median} chars, p90 ${i.p90}, max ${i.max}; saved to a file: ${i.persisted};`
      + ` unchanged from the one before: ${i.unchanged} (${i.unchangedShare})`,
      `  per conversation: median ${k.perConversation.chars.median} chars over ${k.perConversation.injections.median}`
      + ` injections, max ${k.perConversation.chars.max}; since the last compaction median`
      + ` ${k.perConversation.charsSinceCompaction.median}, max ${k.perConversation.charsSinceCompaction.max}`,
      `  turns with an injection: ${k.turns.injected}, working ${k.turns.working}, changing ${k.turns.changing}`,
      `  kept by the agent: ${k.turns.kept} of working (${k.rates.keptOfWorking}), strict ${k.turns.keptStrict}`
      + ` (${k.rates.keptStrictOfWorking}); of changing ${k.turns.keptChanging} (${k.rates.keptOfChanging})`,
      `  end-of-turn reminder: ${k.turns.nudged} of working (${k.rates.nudgedOfWorking}), ${k.turns.nudgedChanging}`
      + ` of changing (${k.rates.nudgedOfChanging}); kinds ${JSON.stringify(k.turns.nudgeKinds)}`,
      `  stale doing rows: ${k.planHealth.doingIdle} of ${k.planHealth.doing} doing, in ${k.planHealth.plans} plans;`
      + ` over a day ${k.planHealth.doingIdleOverDay}, over a week ${k.planHealth.doingIdleOverWeek},`
      + ` median ${k.planHealth.doingIdleMedianHours} hours`);
  }
  return lines;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  measure({ days: Number(opt('--days', String(DEFAULT_DAYS))), since: opt('--since', ''),
    claudeHome: opt('--claude-home', ''), codexHome: opt('--codex-home', '') })
    .then((r) => console.log(args.includes('--json') ? JSON.stringify(r, null, 1) : report(r).join('\n')))
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { measure, report, changes, planCall, normalised, spoke, DEFAULT_DAYS };
