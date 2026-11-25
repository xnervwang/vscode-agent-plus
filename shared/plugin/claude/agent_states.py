# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/agent_states.py; sync-shared.js copies it, so edit it there.

"""What other agents' conversations are doing, as steward.py and steward-peek.py report it: the attention files every VS
Code window with Agent Plus writes in the shared folder (Agent Plus's docs/protocol.md, "Notifications"), read the same
way as in the extension's src/agent-states.js.

A window lists its sources' running conversations there, leaving out stopped ones whose reply has been read, so a
conversation that no file lists is stopped, or no window has it open.
"""
import json
import os
import re
import time

import steward_table

ATTENTION_DIR = "attention"
FORMAT = 1
STALE_SECONDS = 60
MAX_ITEMS = 200
MAX_TOOL = 80
WINDOW = re.compile(r"^[0-9a-z]+-[0-9a-f]{8}\.json$")
RANK = {"waiting": 0, "working": 1, "background": 2, "stopped": 3}
OF_STATE = {"prompt": "waiting", "working": "working", "unread": "stopped", "idle": "stopped"}
KINDS = ("permission", "question", "plan", "choice", "planQuestion")


def shared_home():
    return os.environ.get("AGENT_WORK_PLAN_HOME") or os.path.join(os.path.expanduser("~"), ".agent-work-plan")


def reason_of(raw):
    """{"kind": ...}, with "tool" for a permission whose tool is known, or None."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        return None
    if raw["kind"] != "permission":
        return {"kind": raw["kind"]}
    tool = " ".join(raw["tool"].split())[:MAX_TOOL] if isinstance(raw.get("tool"), str) else ""
    return {"kind": "permission", "tool": tool} if tool else {"kind": "permission"}


def _detail(r):
    return 0 if not r else 1 if r["kind"] == "permission" and not r.get("tool") else 2


def read(now=None, directory=None):
    """key -> {"activity", "unseen", "waitingFor"}."""
    now = time.time() * 1000 if now is None else now
    directory = directory or os.path.join(shared_home(), ATTENTION_DIR)
    out = {}
    try:
        names = os.listdir(directory)
    except OSError:
        return out
    for name in names:
        if not WINDOW.match(name):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        at = d.get("at") if isinstance(d, dict) else None
        if not isinstance(d, dict) or d.get("format") != FORMAT or not isinstance(d.get("items"), list) \
                or not isinstance(at, (int, float)) or isinstance(at, bool) or not now - at < STALE_SECONDS * 1000:
            continue
        for raw in d["items"][:MAX_ITEMS]:
            if not isinstance(raw, dict) or not isinstance(raw.get("sourceId"), str) or not isinstance(raw.get("sessionId"), str) \
                    or raw["sourceId"] == steward_table.CLAUDE:
                continue
            key = "%s:%s" % (raw["sourceId"], raw["sessionId"])
            if not steward_table.KEY.match(key):
                continue
            activity = raw.get("activity") if raw.get("activity") in RANK else OF_STATE.get(raw.get("state"), "")
            unseen = raw["unseen"] if isinstance(raw.get("unseen"), bool) else raw.get("state") == "unread"
            if not activity or (activity == "stopped" and not unseen):
                continue
            it = {"activity": activity, "unseen": unseen, "waitingFor": reason_of(raw.get("waitingFor")) if activity == "waiting" else None}
            had = out.get(key)
            if not had:
                out[key] = it
                continue
            win = it if RANK[activity] < RANK[had["activity"]] else had
            out[key] = {"activity": win["activity"], "unseen": had["unseen"] or unseen,
                        "waitingFor": (it["waitingFor"] if _detail(it["waitingFor"]) > _detail(had["waitingFor"]) else had["waitingFor"])
                        if win["activity"] == "waiting" else None}
    return out


def words(st):
    if not st:
        return "idle, or not open in any window"
    if st["activity"] == "waiting":
        w = st.get("waitingFor") or {}
        if w.get("kind") == "permission":
            return "waiting for the user to approve %s in its window" % (w.get("tool") or "a tool")
        if w.get("kind") == "question":
            return "waiting for the user to answer a question in its window"
        return "waiting for the user in its window"
    if st["activity"] == "working":
        return "working"
    if st["activity"] == "background":
        return "running background work"
    return "idle, reply not read by the user" if st.get("unseen") else "idle"
