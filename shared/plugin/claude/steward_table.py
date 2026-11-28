# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward_table.py; sync-shared.js copies it, so edit it there.

"""The stewards table: stewards.json in this plugin's data directory, read with the same rules the extension uses
(settle in src/stewards.js, leadOf in src/steward-leads.js), so that a table written by an older build reads the same
here. These hooks only read it; every write is a VS Code window's, under the table's lock.

Several stewards can manage the same conversation, but a steward is never on a list. An entry's "ticked" is the part
of its list ticked by hand rather than added by "all"; it is written only for a steward with "all" on. "title" is the
steward's own title, and "newSince", "newSkip" and "newBefore" belong to its "New conversations" switch. "since" gives
when the steward started managing each conversation, and "allSince" when "All, including new ones" was turned on.

Of the stewards that manage a conversation, one is its lead, the only one that may act on it; the others observe it.
Version 4 keeps the leads beside the stewards: "leads" maps a key to { lead, term, at, why, was, pending, tell }, where
"term" goes up by one at every change of lead, "pending" is a hand-over under way and "tell" a note the conversation
has not been shown yet. "tickets" holds the take-over questions a steward asked: "<steward> <key>" -> { at, term }. A
table without "leads", as version 3 writes it, has no lead for any conversation until a window assigns them.

A managed conversation is a key: a Claude Code session id in lower case, or "<source id>:<session id>" for another
agent's conversation, whose session id keeps its case (src/steward-keys.js, the same pattern). "paths" gives the plan
file of each other agent's conversation, as the panel recorded it when the conversation was ticked; these hooks cannot
ask Agent Plus where it is. A key holds a colon, so no file is named after one.
"""
import json
import os
import re
import time

from plan_path import LOCK_SUFFIX, SESSION_NAME, listed
from proc_alive import alive

STEWARDS_FILE = "stewards.json"
WINDOWS_DIR = "windows"
# Claude Code Plus rewrites a window's entry once a minute while the window is open.
WINDOW_STALE_SECONDS = 120
MAX_MANAGED = 100
MAX_NAME = 200
CLAUDE = "claude-code"
KEY = re.compile(r"^([a-z0-9][a-z0-9-]{0,63}):([A-Za-z0-9][A-Za-z0-9_-]{0,199})$")
OTHER_SOURCES = ("opencode-plus",)
LABELS = {"opencode-plus": "OpenCode Agent Plus"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
WHY = ("first", "opened", "new", "migrated", "takeover", "panel", "dead", "dropped", "archived", "none")
TELL_KINDS = ("handover", "intro", "farewell")
MAX_TELL = 4000
# The window takes a take-over question as asked for this long.
TICKET_SECONDS = 30 * 60


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


def _positive(v):
    """`v` when it is a number above 0, else 0 (num in src/steward-leads.js)."""
    w = _when(v)
    return w if w > 0 else 0


def _steward_id(v):
    return v.lower() if isinstance(v, str) and UUID.match(v.lower()) else ""


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
        began = v.get("since") if isinstance(v.get("since"), dict) else {}
        out[sid] = {"manages": manages, "ticked": _ids(v.get("ticked"), sid) if isinstance(v.get("ticked"), list) else None,
                    "names": names, "paths": paths,
                    "since": {m: _positive(began.get(m)) for m in manages if _positive(began.get(m))},
                    "allSince": _positive(v.get("allSince")), "at": _when(v.get("at")), "all": v.get("all") is True,
                    "title": v["title"][:MAX_NAME] if isinstance(v.get("title"), str) else "",
                    "newSince": since, "newSkip": _ids(v.get("newSkip"), sid) if since else [],
                    "newBefore": _ids(v.get("newBefore"), sid) if since else []}
    return out


def leads_of(data):
    """The "leads" of a parsed file, each entry checked as leadsOf in src/steward-leads.js checks it."""
    found = data.get("leads") if isinstance(data, dict) else None
    out = {}
    for k, v in (found.items() if isinstance(found, dict) else []):
        key = managed_id(k)
        if not key or not isinstance(v, dict):
            continue
        e = {"lead": _steward_id(v.get("lead")), "term": int(_positive(v.get("term"))), "at": _positive(v.get("at")),
             "why": v.get("why") if v.get("why") in WHY else "first", "was": _steward_id(v.get("was"))}
        p = v.get("pending")
        if isinstance(p, dict) and _steward_id(p.get("to")):
            e["pending"] = {"to": _steward_id(p["to"]), "at": _positive(p.get("at")),
                            "by": "panel" if p.get("by") == "panel" else "consent"}
        t = v.get("tell")
        if isinstance(t, dict) and t.get("kind") in TELL_KINDS and isinstance(t.get("text"), str):
            e["tell"] = {"kind": t["kind"], "from": _steward_id(t.get("from")), "text": t["text"][:MAX_TELL],
                         "at": _positive(t.get("at"))}
        out[key] = e
    return out


def tickets_of(data):
    """The take-over questions of a parsed file: "<steward> <key>" -> {at, term}."""
    found = data.get("tickets") if isinstance(data, dict) else None
    out = {}
    for k, v in (found.items() if isinstance(found, dict) else []):
        parts = str(k).split(" ")
        s, key = _steward_id(parts[0]), managed_id(parts[1]) if len(parts) > 1 else ""
        if s and key and isinstance(v, dict):
            out[s + " " + key] = {"at": _positive(v.get("at")), "term": int(_positive(v.get("term")))}
    return out


class Table(dict):
    """The settled stewards, steward id -> entry, with the file's leads, tickets and version beside them."""

    def __init__(self, stewards=None, leads=None, tickets=None, version=0):
        dict.__init__(self, stewards or {})
        self.leads = leads or {}
        self.tickets = tickets or {}
        self.version = version


def is_steward(e):
    return bool(e) and (bool(e["manages"]) or e["all"] or e["newSince"] > 0)


def settle(entries):
    """Apply the rules to `entries`, oldest entry first. Each entry keeps the conversations it manages that are not
    stewards yet. An entry that keeps anything, or has a switch on, is a steward, so it is taken off every list it was
    on."""
    order = sorted(entries, key=lambda s: (entries[s]["at"], s))
    out = {}

    def drop(h, c):
        t = out[h]
        t["manages"] = [x for x in t["manages"] if x != c]
        t["ticked"] = [x for x in t["ticked"] if x != c]
        t["names"].pop(c, None)
        t["paths"].pop(c, None)
        t.get("since", {}).pop(c, None)
        if not is_steward(t):
            del out[h]

    for sid in order:
        e = entries[sid]
        mine = set((e["ticked"] or []) if e["all"] else e["manages"])
        kept = [c for c in e["manages"] if c != sid and c not in out]
        since = e.get("newSince") or 0
        t = {"manages": kept, "ticked": [c for c in kept if c in mine],
             "names": {c: e["names"][c] for c in kept if c in e["names"]},
             "paths": {c: e["paths"][c] for c in kept if c in e.get("paths", {})},
             "since": {c: e["since"][c] for c in kept if c in e.get("since", {})}, "allSince": e.get("allSince") or 0,
             "at": e["at"], "all": e["all"],
             "title": e.get("title") or "", "newSince": since,
             "newSkip": list(e.get("newSkip") or []) if since else [], "newBefore": list(e.get("newBefore") or []) if since else []}
        if not is_steward(t):
            continue
        for h in list(out):
            if sid in out[h]["manages"]:
                drop(h, sid)
        out[sid] = t
    return out


# How long a read waits for a window that is writing stewards.json.
READ_WAIT_SECONDS = 0.2


def read_whole(path):
    """The JSON in `path`, or None when there is none. On Windows a read can fail, or find no file at all, at the moment
    a window renames the new file over the old one, and the window holds the lock directory <path>.lock all through it
    (src/file-lock.js in Claude Code Plus); so a read that fails is tried again while the lock is there, for up to
    READ_WAIT_SECONDS, and once more after it goes."""
    until = time.monotonic() + READ_WAIT_SECONDS
    free = 0
    while True:
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            pass
        if os.path.isdir(path + LOCK_SUFFIX):
            free = 0
            if time.monotonic() >= until:
                return None
            time.sleep(0.002)
        else:
            free += 1
            if free > 1:
                return None


def read(directory):
    """The settled table, a Table: steward id -> {manages, ticked, names, paths, since, at, all, ...}, with the leads and
    tickets beside it; empty when there is no readable file."""
    data = read_whole(os.path.join(directory, STEWARDS_FILE))
    if data is None:
        return Table()
    version = data.get("version") if isinstance(data, dict) else 0
    return Table(settle(entries_of(data)), leads_of(data), tickets_of(data),
                 version if isinstance(version, int) and not isinstance(version, bool) else 0)


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


def open_windows(directory):
    """The open windows' entries, as Claude Code Plus writes them: name, folders and the conversations shown."""
    out = []
    folder = os.path.join(directory, WINDOWS_DIR)
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return out
    now = time.time() * 1000
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                w = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(w, dict) or not now - w.get("at", 0) < WINDOW_STALE_SECONDS * 1000 or not alive(w.get("pid")):
            continue
        out.append(w)
    return out


def shown(found, sid):
    """Whether one of the window entries `found` shows conversation `sid`."""
    return any(sid in [str(s).lower() for s in listed(w.get("sessions"))] for w in found)


def on_list(table, steward, key):
    """Whether `key` is on the list of `steward`. A steward with "all" on has every conversation a window shows on its
    list, so unlike manages() this has no shortcut for it: src/steward-leads.js decides leads by the lists alone."""
    t = table.get(steward)
    return bool(t) and key in t["manages"]


def lead_entry(table, key):
    """The table's entry for `key` under "leads", or None."""
    return getattr(table, "leads", {}).get(key)


def lead_of(table, key):
    """The lead of `key`: the one its entry names while that one is a steward with `key` on its list and `key` is no
    steward itself; otherwise "" (leadOf in src/steward-leads.js). A window assigns a lead where this gives ""."""
    e = lead_entry(table, key)
    if not e or not e["lead"] or key in table:
        return ""
    return e["lead"] if on_list(table, e["lead"], key) else ""


def role_of(table, steward, key):
    """"lead" or "observer" for a steward with `key` on its list, else ""."""
    if not on_list(table, steward, key):
        return ""
    return "lead" if lead_of(table, key) == steward else "observer"


def term_of(table, key):
    """The lead term of `key`: 0 while it has no entry under "leads"."""
    e = lead_entry(table, key)
    return e["term"] if e else 0


def title_of(table, key):
    """The title the table records for conversation `key`, from any steward's list, or ""."""
    for t in table.values():
        if t["names"].get(key):
            return t["names"][key]
    return ""


# The first line that fromLine in src/stewards.js puts on a steward's message. Builds of Claude Code Plus write either
# "supervisor" or "steward" there, and transcripts keep lines of both.
FROM = re.compile(r'^Sent by the (?:supervisor|steward) (?:"(.*)" )?\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)'
                  r' for the user:[ \t]*$', re.IGNORECASE)


def sender_of(text):
    """(steward session id, title) named by the first line of `text`, or None."""
    first = str(text or "").lstrip().splitlines()[0] if str(text or "").strip() else ""
    m = FROM.match(first)
    return (m.group(2).lower(), m.group(1) or "") if m else None


def name_of(table, sid):
    """How the hooks name steward `sid`: its title in quotes and its session id."""
    title = (table.get(sid) or {}).get("title") or ""
    return '"%s" (%s)' % (title, sid) if title and title != sid else sid
