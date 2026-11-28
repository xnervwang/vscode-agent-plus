#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward.py; sync-shared.js copies it, so edit it there.

"""UserPromptSubmit hook: for a steward, list the conversations it manages, whether it leads or observes each, and the
state of each; for a managed conversation, name its lead, the one steward that acts on it.

Claude Code Plus's Supervisor panel keeps who manages whom in stewards.json in this plugin's data directory
(src/stewards.js in the extension).

Each managed conversation gets one line: its state from Claude Code's session records, what its plan has in progress,
whether it has background work running, and how many questions it has for the user. Background work is what Claude Code
Plus's windows last found (WORKING_FILE, written by extension.js), used only while the window that wrote it still
runs. Then what changed since the steward's previous turn, kept in <steward>.steward-seen beside its plan.

Another agent's conversation (a key "<source id>:<session id>", steward_table.py) gets its state from Agent Plus's
attention files (agent_states.py) and its plan from the path the table recorded for it. It has no background work
here.

If nothing in the list changed since the steward's previous turn, it gets one sentence saying so: the list is already
in its context, and a steward wakes many times with nothing new. After each compaction the whole list is sent again
(COMPACTED_SUFFIX, written by resume-work-plan.py).

For a conversation the steward observes, the line also names its lead (steward_table.py). The seen file keeps each
conversation's role too, so the turn after one changes says so once.

Both forms start with lead(), which also gives RELAYED: a message the lead passes on with steward-relay.py is the user's
own in that conversation.

A managed conversation is told about its lead (watched()); the stewards that observe it are not mentioned. The whole
note comes on its first turn, after its lead or the lead's term changed, and after each compaction; any other turn
gets the one line of still_led(). What it was last told is kept in TOLD_DIR/<session id>.json in the plugin's data
directory, replaced with an atomic rename. It holds the lead and its title (the line about a change of lead names that
title as the one before), the lead's term, the note under "tell" in stewards.json last shown, and the compaction it
followed.

A running steward keeps following the steward skill it loaded, even after an update of Claude Code Plus brings a new
one. The seen file keeps a short hash of the skill the steward was last told about. When the hash differs, or the seen
file is from a build that kept none, the turn also gives SKILL_CHANGED, which tells it to load the skill again.
"""

import hashlib
import json
import os
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_common import (  # noqa: E402
    COMPACTED_SUFFIX, SESSION_NAME, children, data_dir, launcher, listed, read_payload, side_file, write_quietly,
)
from proc_alive import alive  # noqa: E402
import agent_states  # noqa: E402
import steward_table  # noqa: E402

SEEN_SUFFIX = ".steward-seen"
MAX_LISTED = 30
MAX_DOING = 2
TITLE_CHARS = 80
STATE_WORDS = {"busy": "working", "shell": "running a command", "waiting": "waiting for the user", "idle": "idle"}
STOPPED = "not running"
RELAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "steward-relay.py")
# A skill is named after its folder, and a plugin may ship this one under either name.
SKILLS = [os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "skills", name, "SKILL.md")
          for name in ("supervisor", "steward")]
SKILL_CHANGED = ("The supervisor skill has changed since your previous turn (it is now version %s): load it again with the "
                 "Skill tool before you act, and follow the new one where the two differ.")
WORKING_FILE = "working.json"
OTHERS_HINT = ("The conversations of other agents above take only plain messages: no `--rename`, `--close` or `--resume`. "
               "While one waits at a prompt for tool approval or an answer to a question, no message reaches it. Ask the "
               "user to answer that prompt in that window; nobody else can.")
RELAYED = ("A message you pass on with steward-relay.py to a conversation you lead is the user's own message there, "
           "approvals included. Do not ask the user to say it there themselves.")
OBSERVED = ("Read and report on a conversation you observe; do not act on it until the user agrees that you take it "
            "over, as the skill says.")
TOLD_DIR = "stewards-told"
NO_LEAD = "No supervisor watches this conversation now; put questions for the user in your plan."
DECISIONS = ("Release, push a tag, approve, merge or speak for the user in public only on the user's own words: what the user "
             "types here, or what your lead supervisor's messages say apart from sentences marked as the supervisor's "
             "arrangement.")
FIRST_LINE = '`Sent by the supervisor "<title>" (<session id>) for the user:`'
TOLD_NOTE = "This note was left for you while no window had this conversation open:"


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def states():
    """session id -> state word, from the records of running claude processes."""
    out = {}
    folder = os.path.join(claude_dir(), "sessions")
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".json") and n[:-5].isdigit()]
    except OSError:
        return out
    for name in names:
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        sid = str(rec.get("sessionId") or "").lower() if isinstance(rec, dict) else ""
        pid = rec.get("pid") if isinstance(rec, dict) else None
        if not SESSION_NAME.match(sid) or not isinstance(pid, int) or not alive(pid):
            continue
        word = STATE_WORDS.get(rec.get("status"), "running")
        # A conversation held by two processes reads as the busier of them.
        if out.get(sid) in (None, "idle"):
            out[sid] = word
    return out


def background(directory):
    """Session ids with background work running, from the set a Claude Code Plus window wrote; empty when no running
    window wrote one."""
    try:
        with open(os.path.join(directory, WORKING_FILE), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return set()
    if not isinstance(d, dict) or not isinstance(d.get("pid"), int) or not alive(d["pid"]):
        return set()
    return {s.lower() for s in listed(d.get("sessions")) if isinstance(s, str) and SESSION_NAME.match(s)}


def plan_summary(path):
    """(titles of rows in progress, questions waiting on the user) from the plan at `path`."""
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError):
        return [], 0
    doing, questions = [], [0]

    def walk(nodes):
        for n in listed(nodes):
            if not isinstance(n, dict):
                continue
            if n.get("state") == "doing" and len(doing) < MAX_DOING:
                doing.append(str(n.get("title") or "")[:TITLE_CHARS])
            if n.get("waitingOn") == "user" and n.get("state") in ("waiting", "discussing"):
                questions[0] += 1
            walk(children(n))

    walk(plan.get("nodes") if isinstance(plan, dict) else None)
    return doing, questions[0]


def managed_by(table, sid):
    """(keys, names, plan paths) of what this conversation manages."""
    entry = table.get(sid)
    if not entry:
        return [], {}, {}
    return entry["manages"][:MAX_LISTED], entry["names"], entry["paths"]


def lead_open(directory, lead):
    """Whether a VS Code window shows steward `lead` now."""
    return steward_table.shown(steward_table.open_windows(directory), lead)


def handoff_command():
    return " ".join([shlex.quote(w) for w in launcher()] + [shlex.quote(RELAY), "--handoff"])


def watched(lead, table, open_now=True):
    return ("Your lead supervisor is %s. It watches this conversation for the user through Claude Code Plus: it reads your "
            "work plan and latest reply, and speaks for the user by typing messages here, which come as the user's own. "
            "Each such message starts with the line %s. %s %s If a message plainly belongs elsewhere (meant for another "
            "conversation, unrelated to the work here, or better done by another one), do not start background work for "
            "it here: run %s with a here-document holding the user's words, where it should go (a session id, or a folder "
            "for a new conversation) and why; it goes to your lead supervisor. Say in one sentence what it answered."
            % (steward_table.name_of(table, lead), FIRST_LINE, DECISIONS,
               "Do not send it status messages; put questions for the user in your plan as rows waiting on the user, where "
               "it sees them." if open_now else
               "It is not open in a VS Code window now, so put questions for the user in your plan as rows waiting on the "
               "user for now.", handoff_command()))


def still_led(lead, table, open_now=True):
    """The one-line note for a conversation that has already had the whole note."""
    return "Your lead supervisor is still %s%s. %s" % (
        steward_table.name_of(table, lead),
        "" if open_now else "; it is not open in a VS Code window now, so put questions for the user in your plan", DECISIONS)


def told_file(directory, sid):
    return os.path.join(directory, TOLD_DIR, sid + ".json")


def tell_key(tell):
    return "%s:%s" % (tell["at"], hashlib.sha1(tell["text"].encode("utf-8")).hexdigest()[:8])


def managed_note(directory, sid, table, compacted):
    """What managed conversation `sid` is told this turn about its lead, or "". The told file in TOLD_DIR keeps a
    record of it."""
    entry = steward_table.lead_entry(table, sid) or {}
    over = steward_table.stewards_of(table, sid)
    tell = entry.get("tell")
    if not over and not tell:
        return ""
    path = told_file(directory, sid)
    try:
        with open(path, encoding="utf-8") as fh:
            told = json.load(fh)
        told = told if isinstance(told, dict) else {}
        first = False
    except (OSError, ValueError):
        told, first = {}, True
    lead, term = steward_table.lead_of(table, sid), steward_table.term_of(table, sid)
    title = (table.get(lead) or {}).get("title") or lead
    changed = not first and (told.get("lead") != lead or told.get("term") != term)
    lines = []
    if changed and lead and told.get("lead") and told.get("lead") != lead:
        lines.append('Your lead supervisor is now "%s" (was "%s").' % (title, told.get("title") or told["lead"]))
    shown = told.get("tell", "")
    if tell and tell_key(tell) != shown:
        lines.append(TOLD_NOTE + "\n" + tell["text"])
        shown = tell_key(tell)
    if over and not lead:
        lines.append(NO_LEAD)
    elif over:
        open_now = lead_open(directory, lead)
        lines.append(watched(lead, table, open_now) if first or changed or told.get("compacted", "") != compacted
                     else still_led(lead, table, open_now))
    record = {"lead": lead, "term": term, "title": title if lead else "", "tell": shown, "compacted": compacted}
    if record != told:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        except OSError:
            pass
        write_quietly(path, json.dumps(record, ensure_ascii=False))
    return "\n".join(lines)


def roles_of(table, sid, ids):
    """key -> (role, how its line names it): "lead", or "observer" and the steward that leads it."""
    out = {}
    for m in ids:
        head = steward_table.lead_of(table, m)
        if head == sid:
            out[m] = ("lead", "lead")
        else:
            who = '"%s"' % table[head]["title"] if head and table.get(head, {}).get("title") else head
            out[m] = ("observer", "observer (lead: %s)" % who if head else "observer (no lead now)")
    return out


def lines_of(ids, names, now, directory, paths=None, roles=None):
    lines = []
    running = background(directory)
    paths = paths or {}
    roles = roles or {}
    for m in ids:
        name = str(names.get(m) or m)[:TITLE_CHARS]
        other = steward_table.is_other(m)
        plan = paths.get(m) if other else os.path.join(directory, m + ".json")
        doing, questions = plan_summary(plan) if plan else ([], 0)
        parts = ([roles[m][1]] if m in roles else []) + [now.get(m, STOPPED)]
        if other and not plan:
            parts.append("where its plan is was not recorded")
        if m in running:
            parts.append("background work running")
        if doing:
            parts.append("doing: " + " / ".join(doing))
        if questions:
            parts.append("%d question%s for the user" % (questions, "" if questions == 1 else "s"))
        where = "%s, %s" % (m, steward_table.label_of(m)) if other else m
        lines.append('- "%s" (%s): %s' % (name, where, "; ".join(parts)))
    return lines


def skill_version():
    for path in SKILLS:
        try:
            with open(path, "rb") as fh:
                return hashlib.sha1(fh.read()).hexdigest()[:8]
        except OSError:
            continue
    return ""


def lead(ids, roles=None):
    roles = roles or {}
    others = [steward_table.label_of(m) for m in ids if steward_table.is_other(m)]
    observed = len([m for m in ids if roles.get(m, ("lead",))[0] == "observer"])
    if not observed:
        split = ""
    elif observed < len(ids):
        split = " You lead %d of them and observe %d." % (len(ids) - observed, observed)
    else:
        split = " You observe %s." % ("it" if observed == 1 else "all of them")
    after = " %s%s" % (RELAYED, " " + OBSERVED if observed else "")
    if not others:
        return ("You are the supervisor of %d Claude Code conversation%s the user picked for you in the Supervisor panel; "
                "follow the supervisor skill.%s%s" % (len(ids), "" if len(ids) == 1 else "s", split, after))
    counts = ["%d Claude Code" % (len(ids) - len(others))] if len(ids) > len(others) else []
    counts += ["%d %s" % (others.count(label), label) for label in sorted(set(others))]
    return ("You are the supervisor of %d conversation%s the user picked for you in the Supervisor panel (%s); "
            "follow the supervisor skill.%s%s" % (len(ids), "" if len(ids) == 1 else "s", ", ".join(counts), split, after))


def block(ids, names, now, seen, lines, roles=None, was=None, table=None):
    roles, was = roles or {}, was or {}
    changed = ['"%s": %s -> %s' % (str(names.get(m) or m)[:TITLE_CHARS], seen[m], now.get(m, STOPPED))
               for m in ids if m in seen and seen[m] != now.get(m, STOPPED)]
    text = lead(ids, roles) + " Where they stand now:\n" + "\n".join(lines)
    if any(steward_table.is_other(m) for m in ids):
        text += "\n" + OTHERS_HINT
    if changed:
        text += "\nChanged since your previous turn: " + "; ".join(changed) + "."
    moved = []
    for m in ids:
        name = str(names.get(m) or m)[:TITLE_CHARS]
        if was.get(m) == "observer" and roles.get(m, ("",))[0] == "lead":
            moved.append('you now lead "%s"' % name)
        elif was.get(m) == "lead" and roles.get(m, ("",))[0] == "observer":
            now_lead = steward_table.lead_of(table, m) if table is not None else ""
            moved.append('you no longer lead "%s"%s and observe it now' % (
                name, " (%s does)" % steward_table.name_of(table, now_lead) if now_lead else ""))
    if moved:
        text += "\nLead changes since your previous turn: " + "; ".join(moved) + "."
    return text


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    sid = str(payload.get("session_id") or "").lower()
    if not SESSION_NAME.match(sid):
        return 0
    directory = data_dir()
    table = steward_table.read(directory)
    ids, names, paths = managed_by(table, sid)
    try:
        with open(side_file(os.path.join(directory, sid + ".json"), COMPACTED_SUFFIX), encoding="utf-8") as fh:
            compacted = fh.read().strip()
    except OSError:
        compacted = ""
    if not ids:
        note = managed_note(directory, sid, table, compacted)
        if note:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": note}}))
        return 0
    now = states()
    if any(steward_table.is_other(m) for m in ids):
        found = agent_states.read()
        for m in ids:
            if steward_table.is_other(m):
                now[m] = agent_states.words(found.get(m))
    seen_path = side_file(os.path.join(directory, sid + ".json"), SEEN_SUFFIX)
    known = True
    try:
        with open(seen_path, encoding="utf-8") as fh:
            last = json.load(fh)
        last = last if isinstance(last, dict) else {}
    except (OSError, ValueError):
        last, known = {}, False
    # Older builds stored the states map on its own.
    seen = last.get("states") if isinstance(last.get("states"), dict) else ({} if "digest" in last else last)
    was = last.get("roles") if isinstance(last.get("roles"), dict) else {}
    roles = roles_of(table, sid, ids)
    lines = lines_of(ids, names, now, directory, paths, roles)
    digest = hashlib.sha1("\n".join(lines).encode("utf-8")).hexdigest()
    if last.get("digest") == digest and last.get("compacted", "") == compacted:
        text = lead(ids, roles) + " Nothing has changed since your previous turn."
    else:
        text = block(ids, names, now, seen, lines, roles, was, table)
    # Without a seen file this is the steward's first turn, which reads the skill anyway.
    version = skill_version()
    if version and known and last.get("skill") != version:
        text += "\n" + SKILL_CHANGED % version
    note = managed_note(directory, sid, table, compacted)
    if note:
        text += "\n" + note
    write_quietly(seen_path, json.dumps({"states": {m: now.get(m, STOPPED) for m in ids}, "digest": digest, "compacted": compacted,
                                         "skill": version, "roles": {m: roles[m][0] for m in ids}}))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
