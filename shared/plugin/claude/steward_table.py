# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward_table.py; sync-shared.js copies it, so edit it there.

"""The stewards table: stewards.json in this plugin's data directory, read with the same rules the extension uses
(settle in src/stewards.js), so that a table written by an older build reads the same here.

A conversation can have several stewards; a steward has no steward of its own. An entry's "ticked" is the part of its
list ticked by hand rather than added by "all"; it is written only for a steward with "all" on. "title" is the
steward's own title, and "newSince", "newSkip" and "newBefore" belong to its "New conversations" switch.

A managed conversation is a key: a Claude Code session id in lower case, or "<source id>:<session id>" for another
agent's conversation, whose session id keeps its case (src/steward-keys.js, the same pattern). "paths" gives the plan
file of each other agent's conversation, as the panel recorded it when the conversation was ticked; these hooks cannot
ask Agent Plus where it is. A key holds a colon, so no file is named after one.
"""
import json
import os
import re

from plan_path import SESSION_NAME, listed

STEWARDS_FILE = "stewards.json"
MAX_MANAGED = 100
MAX_NAME = 200
CLAUDE = "claude-code"
KEY = re.compile(r"^([a-z0-9][a-z0-9-]{0,63}):([A-Za-z0-9][A-Za-z0-9_-]{0,199})$")
OTHER_SOURCES = ("opencode-plus",)
LABELS = {"opencode-plus": "OpenCode Agent Plus"}


def parse(key):
    """(source id, session id) of a key, or None."""
    if not isinstance(key, str):
        return None
    if SESSION_NAME.match(key):
        return CLAUDE, key.lower()
    m = KEY.match(key)
    return (m.group(1), m.group(2)) if m else None


def is_other(key):
    p = parse(key)
    return bool(p) and p[0] != CLAUDE


def allowed(key):
    p = parse(key)
    return bool(p) and p[0] in OTHER_SOURCES


def managed_id(x):
    p = parse(x)
    if not p:
        return ""
    if p[0] == CLAUDE:
        return p[1].lower() if SESSION_NAME.match(p[1]) else ""
    return x


def label_of(key):
    p = parse(key)
    return LABELS.get(p[0], p[0]) if p else ""


def plan_file_ok(key, path):
    p = parse(key)
    return bool(p) and p[0] != CLAUDE and isinstance(path, str) and os.path.isabs(path) \
        and os.path.basename(path) == p[1] + ".json"


def _ids(value, not_):
    out = []
    for x in listed(value):
        x = managed_id(x)
        if x and x != not_ and x not in out:
            out.append(x)
    return out[:MAX_MANAGED]


def _when(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf") else 0


def entries_of(data):
    """The entries of a parsed file, with `ticked` None when it is not written."""
    found = data.get("stewards") if isinstance(data, dict) else None
    out = {}
    for key, v in (found.items() if isinstance(found, dict) else []):
        if not isinstance(key, str) or not SESSION_NAME.match(key) or not isinstance(v, dict):
            continue
        sid = key.lower()
        manages = _ids(v.get("manages"), sid)
        given = v.get("names") if isinstance(v.get("names"), dict) else {}
        names = {m: given[m][:MAX_NAME] for m in manages if isinstance(given.get(m), str)}
        files = v.get("paths") if isinstance(v.get("paths"), dict) else {}
        paths = {m: files[m] for m in manages if plan_file_ok(m, files.get(m))}
        since = v.get("newSince") if _when(v.get("newSince")) > 0 else 0
        out[sid] = {"manages": manages, "ticked": _ids(v.get("ticked"), sid) if isinstance(v.get("ticked"), list) else None,
                    "names": names, "paths": paths, "at": _when(v.get("at")), "all": v.get("all") is True,
                    "title": v["title"][:MAX_NAME] if isinstance(v.get("title"), str) else "",
                    "newSince": since, "newSkip": _ids(v.get("newSkip"), sid) if since else [],
                    "newBefore": _ids(v.get("newBefore"), sid) if since else []}
    return out


def is_steward(e):
    return bool(e) and (bool(e["manages"]) or e["all"] or e["newSince"] > 0)


def settle(entries):
    """The table after the rules are applied. The entries are taken oldest first; each keeps what it manages except
    conversations that are stewards by then. An entry that keeps anything, or has a switch on, is a steward, so it is
    taken off every list it was on."""
    order = sorted(entries, key=lambda s: (entries[s]["at"], s))
    out = {}

    def drop(h, c):
        t = out[h]
        t["manages"] = [x for x in t["manages"] if x != c]
        t["ticked"] = [x for x in t["ticked"] if x != c]
        t["names"].pop(c, None)
        t["paths"].pop(c, None)
        if not is_steward(t):
            del out[h]

    for sid in order:
        e = entries[sid]
        mine = set((e["ticked"] or []) if e["all"] else e["manages"])
        kept = [c for c in e["manages"] if c != sid and c not in out]
        since = e.get("newSince") or 0
        t = {"manages": kept, "ticked": [c for c in kept if c in mine],
             "names": {c: e["names"][c] for c in kept if c in e["names"]},
             "paths": {c: e["paths"][c] for c in kept if c in e.get("paths", {})}, "at": e["at"], "all": e["all"],
             "title": e.get("title") or "", "newSince": since,
             "newSkip": list(e.get("newSkip") or []) if since else [], "newBefore": list(e.get("newBefore") or []) if since else []}
        if not is_steward(t):
            continue
        for h in list(out):
            if sid in out[h]["manages"]:
                drop(h, sid)
        out[sid] = t
    return out


def read(directory):
    """steward id -> {manages, ticked, names, paths, at, all}, settled; {} when there is no readable file."""
    try:
        with open(os.path.join(directory, STEWARDS_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return settle(entries_of(data))


def manages(table, steward, sid):
    """Whether `steward` manages `sid`: `sid` is on its list, or `steward` has "all" on and `sid` is not a steward."""
    t = table.get(steward)
    if not t:
        return False
    return sid in t["manages"] or (t["all"] and sid != steward and sid not in table)


def stewards_of(table, sid):
    """The stewards that manage `sid`, in table order (stewardsOf in src/stewards.js)."""
    if not isinstance(sid, str) or not sid or sid in table:
        return []
    if is_other(sid) and not allowed(sid):
        return []
    return [s for s in table if manages(table, s, sid)]


# The line a steward's message starts with (fromLine in src/stewards.js).
FROM = re.compile(r'^Sent by the steward (?:"(.*)" )?\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)'
                  r' for the user:[ \t]*$')


def sender_of(text):
    """(steward session id, title) named by the first line of `text`, or None."""
    first = str(text or "").lstrip().splitlines()[0] if str(text or "").strip() else ""
    m = FROM.match(first)
    return (m.group(2).lower(), m.group(1) or "") if m else None


def name_of(table, sid):
    """How the hooks name steward `sid`: its title in quotes and its session id."""
    title = (table.get(sid) or {}).get("title") or ""
    return '"%s" (%s)' % (title, sid) if title and title != sid else sid
