#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward-send-guard.py; sync-shared.js copies it, so edit it there.

"""PreToolUse hook on SendMessage: refuses a steward's message to a conversation that another steward leads, or that
has no lead. steward-relay.py is refused at the window for the same reason; SendMessage reaches
the other session directly, so it is refused here, before the call.

SendMessage takes as its recipient the name of a running Claude Code session, with " [ref]" after it when two share
the name, or a session id. Each running session keeps a record in ~/.claude/sessions/<pid>.json with its
"name", "sessionId" and "messagingSocketPath". The call is denied only when this conversation is a steward and every
live session the recipient names is on some steward's list (steward_table.py) and is not led by this steward. Any
other recipient is let through: a subagent, a teammate, "main", a session on another machine, a name that no record
has, or a name two sessions share when not both are managed. So is any call from a conversation that is not a steward.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_common import data_dir, read_payload  # noqa: E402
from proc_alive import alive  # noqa: E402
import steward_table  # noqa: E402

# A name two sessions share, followed by the " [ref]" that SendMessage adds to tell them apart.
REF = re.compile(r"^(.*\S)\s*\[[0-9a-f]{6,12}\]$")


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def sessions():
    """The records of the running Claude Code sessions: (name, session id), the id in lower case."""
    out = []
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
        if not isinstance(rec, dict) or not isinstance(rec.get("pid"), int) or not alive(rec["pid"]):
            continue
        sid = str(rec.get("sessionId") or "").lower()
        if steward_table.UUID.match(sid):
            out.append((str(rec.get("name") or ""), sid))
    return out


def recipients(to, found):
    """The session ids of the live sessions that `to` names."""
    to = str(to or "").strip()
    if steward_table.UUID.match(to.lower()):
        return [to.lower()]
    m = REF.match(to)
    want = " ".join((m.group(1) if m else to).split()).casefold()
    return [sid for name, sid in found if want and " ".join(name.split()).casefold() == want]


def listed(table, key):
    """Whether some steward has `key` on its list, so that a window gives it a lead."""
    return any(steward_table.on_list(table, s, key) for s in table) and key not in table


def reason(table, me, key):
    """Why steward `me` may not send to `key` with SendMessage, or ""."""
    if not listed(table, key):
        return ""
    lead = steward_table.lead_of(table, key)
    if lead == me:
        return ""
    title = steward_table.title_of(table, key) or key
    if lead:
        why = '"%s" is led by %s' % (title, steward_table.name_of(table, lead)) + (
            "; you observe it" if steward_table.on_list(table, me, key) else "")
    else:
        why = '"%s" has no lead supervisor now' % title
    return ("Not sent: %s. A supervisor sends nothing with SendMessage to a conversation it does not lead. Read it with "
            "steward-peek.py, and to act on it run steward-relay.py --take-lead %s --ask and ask the user." % (why, key))


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("tool_name") != "SendMessage":
        return 0
    args = payload.get("tool_input")
    me = str(payload.get("session_id") or "").lower()
    if not isinstance(args, dict) or not steward_table.UUID.match(me):
        return 0
    table = steward_table.read(data_dir())
    if me not in table:
        return 0
    ids = recipients(args.get("to"), sessions())
    why = [reason(table, me, sid) for sid in ids]
    if not why or not all(why):
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "PreToolUse"),
        "permissionDecision": "deny",
        "permissionDecisionReason": why[0],
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
