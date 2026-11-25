#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward-peek.py; sync-shared.js copies it, so edit it there.

"""Print one conversation's state, open plan rows and latest reply text, for a steward.

    python3 steward-peek.py <session id> [<plugin data directory>]
    python3 steward-peek.py --said <session id> [<plugin data directory>]

Prints the conversation's state from Claude Code's session records, its plan's open rows with the questions it has
for the user, and the text it wrote after the user's last message, without tool calls, tool output or thinking.

--said prints the user's latest messages in that conversation instead, oldest first, each with its time: what was
typed into it, also while a turn ran, and not messages from other sessions or notices. A steward checks a handoff
against them. Read-only.

For another agent's conversation, whose key is "<source id>:<session id>" (steward_table.py), the state comes from
Agent Plus's attention files (agent_states.py) and the plan from the path the Steward panel recorded in stewards.json.
The latest reply and --said come from <session id>.reply.json, which its agent writes beside that plan at the end of
each turn: { format, at, lastUserAt, said: [{ text, at }], reply }, cut to the limits below already.
"""

import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_common import OPEN_STATES, children, listed, open_tail  # noqa: E402
import plan_agent as A  # noqa: E402
from proc_alive import alive  # noqa: E402
import agent_states  # noqa: E402
import steward_table  # noqa: E402

TAIL_BYTES = 4 * 1024 * 1024
MAX_REPLY_CHARS = 6000
MAX_SAID = 5
MAX_SAID_CHARS = 2000
# Text that reaches a conversation as a user message without the user typing it.
NOT_TYPED = ("<cross-session-message", "<task-notification", "Steward notice from Claude Code Plus", "Handoff from ")
STATE_WORDS = {"busy": "working", "shell": "running a command", "waiting": "waiting for the user", "idle": "idle"}
REPLY_SUFFIX = ".reply.json"
REPLY_FORMAT = 1


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def state_of(sid):
    folder = os.path.join(claude_dir(), "sessions")
    found = []
    for path in glob.glob(os.path.join(folder, "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and str(rec.get("sessionId") or "").lower() == sid and isinstance(rec.get("pid"), int):
            if not alive(rec["pid"]):
                continue
            found.append(STATE_WORDS.get(rec.get("status"), "running"))
    if not found:
        return "not running"
    return next((w for w in found if w != "idle"), "idle")


def plan_lines(path):
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError):
        return ["(no work plan)"]
    out = []

    def walk(nodes, prefix):
        for i, n in enumerate(listed(nodes), 1):
            if not isinstance(n, dict):
                continue
            num = "%s%d" % (prefix + "." if prefix else "", i)
            if n.get("state") in OPEN_STATES:
                line = "%s. [%s] %s" % (num, n.get("state"), n.get("title") or "")
                if n.get("waitingOn") == "user" and n.get("question"):
                    line += "\n     question for the user: " + str(n.get("question"))
                out.append(line)
            walk(children(n), num)

    walk(plan.get("nodes") if isinstance(plan, dict) else None, "")
    return out or ["(no open rows)"]


def transcript(sid):
    hits = glob.glob(os.path.join(claude_dir(), "projects", "*", sid + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else ""


def is_prompt(row):
    """A message the user typed, as opposed to a tool result or something the client added."""
    if row.get("type") != "user" or row.get("isMeta") or row.get("isSidechain"):
        return False
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return bool(content.strip())
    return any(isinstance(b, dict) and b.get("type") == "text" for b in listed(content)) and \
        not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in listed(content))


def latest_reply(path):
    """The text of what the conversation said after the user's last message, oldest part first."""
    tail = open_tail(path)
    if tail is None:
        return ""
    texts = []
    for line in tail.lines(TAIL_BYTES):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if is_prompt(row):
            break
        if row.get("type") == "assistant" and not row.get("isSidechain"):
            for b in reversed(listed((row.get("message") or {}).get("content"))):
                if isinstance(b, dict) and b.get("type") == "text" and str(b.get("text") or "").strip():
                    texts.append(str(b["text"]).strip())
    reply = "\n\n".join(reversed(texts))
    return reply if len(reply) <= MAX_REPLY_CHARS else "..." + reply[-MAX_REPLY_CHARS:]


def prompt_text(row):
    """What the user typed, on a row that is_prompt() accepts or that records a message typed while a turn ran."""
    att = row.get("attachment")
    if isinstance(att, dict) and att.get("type") == "queued_command" and isinstance(att.get("prompt"), str):
        return att["prompt"].strip()
    if not is_prompt(row):
        return ""
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    return "\n".join(str(b.get("text") or "") for b in listed(content) if isinstance(b, dict) and b.get("type") == "text").strip()


def said(path):
    """The user's latest messages in a transcript, oldest first, as (time, text)."""
    tail = open_tail(path)
    if tail is None:
        return []
    out = []
    for line in tail.lines(TAIL_BYTES):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("isSidechain"):
            continue
        text = prompt_text(row)
        if not text or text.startswith(NOT_TYPED) or (out and out[-1][1] == text):
            continue
        out.append((str(row.get("timestamp") or "")[:19].replace("T", " "), text))
        if len(out) >= MAX_SAID:
            break
    return list(reversed(out))


def recorded_plan(directory, key):
    for entry in steward_table.read(directory).values():
        if entry["paths"].get(key):
            return entry["paths"][key]
    return ""


def reply_file(plan):
    try:
        with open(os.path.splitext(plan)[0] + REPLY_SUFFIX, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return 0, None
    if not isinstance(d, dict) or not isinstance(d.get("format"), int) or isinstance(d.get("format"), bool):
        return 0, None
    return d["format"], d


def utc(ms):
    if not isinstance(ms, (int, float)) or isinstance(ms, bool) or ms <= 0:
        return ""
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ms / 1000))
    except (OverflowError, ValueError, OSError):
        return ""


def print_said(found):
    for at, text in found:
        sender = steward_table.sender_of(text)
        by = " (sent by the steward %s, not typed by the user there)" % (
            '"%s" (%s)' % (sender[1], sender[0]) if sender[1] else sender[0]) if sender else ""
        print(("%s UTC" % at if at else "(no time)") + by + ":")
        print("  " + (text if len(text) <= MAX_SAID_CHARS else text[:MAX_SAID_CHARS] + "...").replace("\n", "\n  "))
    if not found:
        print("No message from the user was found in that conversation.")


def peek_other(key, directory, said_only):
    plan = recorded_plan(directory, key)
    fmt, body = reply_file(plan) if plan else (0, None)
    if said_only:
        found = [(utc(x.get("at")), x["text"].strip()) for x in listed(body.get("said"))
                 if isinstance(x, dict) and isinstance(x.get("text"), str) and x["text"].strip()] if fmt == REPLY_FORMAT else []
        print_said(found)
        return 0
    print("source: " + steward_table.label_of(key))
    print("state: " + agent_states.words(agent_states.read().get(key)))
    print("plan:")
    for line in plan_lines(plan) if plan else ["(where its plan is was not recorded; the Steward panel records it when the "
                                               "conversation is ticked)"]:
        print("  " + line)
    print("latest reply:")
    if fmt > REPLY_FORMAT:
        print("(written by a later version of %s, which this script does not read)" % steward_table.label_of(key))
    else:
        reply = body.get("reply") if fmt == REPLY_FORMAT else ""
        print(reply.strip() if isinstance(reply, str) and reply.strip() else "(none found)")
    return 0


def main(argv):
    if len(argv) in (3, 4) and argv[1] == "--said" and steward_table.managed_id(argv[2]):
        key = steward_table.managed_id(argv[2])
        if steward_table.is_other(key):
            return peek_other(key, argv[3] if len(argv) > 3 else A.FALLBACK, True)
        path = transcript(key)
        print_said(said(path) if path else [])
        return 0
    if len(argv) < 2 or not steward_table.managed_id(argv[1]):
        sys.stderr.write("usage: steward-peek.py <session id> [<plugin data directory>] | --said <session id> [<plugin data directory>]\n")
        return 2
    sid = steward_table.managed_id(argv[1])
    directory = argv[2] if len(argv) > 2 else A.FALLBACK
    if steward_table.is_other(sid):
        return peek_other(sid, directory, False)
    print("state: " + state_of(sid))
    print("plan:")
    for line in plan_lines(os.path.join(directory, sid + ".json")):
        print("  " + line)
    path = transcript(sid)
    print("latest reply:")
    reply = latest_reply(path) if path else ""
    print(reply or "(none found)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
