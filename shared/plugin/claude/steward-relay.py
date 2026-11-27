#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward-relay.py; sync-shared.js copies it, so edit it there.

"""A steward's requests for the conversations it manages.

    python3 steward-relay.py <session id> [<plugin data directory>] <<'EOF'
    <the message, worded for that conversation>
    EOF
    python3 steward-relay.py --anyway <session id> [<plugin data directory>] <<'EOF'
    <the same message>
    EOF
    python3 steward-relay.py --rename <session id> [<plugin data directory>] <<'EOF'
    <the new title>
    EOF
    python3 steward-relay.py --close [--confirmed] <session id> [<plugin data directory>]
    python3 steward-relay.py --open <folder> [<plugin data directory>] <<'EOF'
    <the new conversation's first message>
    EOF
    python3 steward-relay.py --resume <session id> [<plugin data directory>] [<<'EOF'
    <a message for it, sent once it is open>
    EOF]
    python3 steward-relay.py --windows [<plugin data directory>]
    python3 steward-relay.py --handoff [--to <supervisor session id>] [<plugin data directory>] <<'EOF'
    <the user's words, where they should go, and why>
    EOF
    python3 steward-relay.py --take <session id, key or exact title> [<plugin data directory>]
    python3 steward-relay.py --drop <session id, key or exact title> [<plugin data directory>]
    python3 steward-relay.py --all on|off [<plugin data directory>]
    python3 steward-relay.py --new on|off [<plugin data directory>]
    python3 steward-relay.py --archive <session id> [<session id> ...] [<plugin data directory>]

Run from the steward conversation: its session id comes from CLAUDE_CODE_SESSION_ID. Claude Code Plus types the
message into that conversation's input in the VS Code window that has it open and sends it, so it arrives as the
user's own message, approvals included, after a first line naming this steward. The window first looks for this
command in the steward's transcript, so give the message in a here-document as above. When another steward sent the
same conversation a message in the last 30 minutes, the script sends nothing and prints what was sent; --anyway sends
yours after all.

--rename gives the conversation a new title. --close closes its editor tab; the conversation is not deleted and can be
opened again from the session list. A conversation that is working, waiting for an answer or running background work is
closed only with --confirmed. --open starts a new conversation in the VS Code window whose first folder is <folder>,
sends it the message and prints its session id, or says that no window has the folder open.
--windows prints the open windows and their folders.

--resume opens a conversation that no window shows, in an editor tab of the VS Code window whose first folder is the one
Claude Code keeps the conversation under, since Claude Code finds a window's stored conversations only there, and then
sends it the message, if one is given. It is not done while a window shows the conversation or another process runs it;
it says which. A conversation opened with --open or --resume is then ticked for this steward in the Supervisor panel; the
printed answer mentions the tick.

--handoff is run from a conversation a steward manages, not from the steward: it gives a steward something the
conversation thinks belongs elsewhere, as a notice that is not the user's message. It goes to the steward named with
--to, which must be one of the conversation's stewards. Without --to, it goes to the steward whose message started
this turn, or else to the one the user last typed to.

--take and --drop tick or untick one conversation for this steward in the Supervisor panel, named by its session id, its
key, or its exact title (in a here-document instead, when it is awkward in a command line). --all turns "All, including
new ones" on or off, and --new "New conversations". The window that shows the steward makes the change only when the
latest message before this command in the steward conversation is one the user typed there; otherwise it prints why.

--archive <session id> [<session id> ...] [<plugin data directory>] asks the window showing the steward to archive the
named conversations in Agent Plus's session list. You can also give the session ids one per line in a here-document.
Give at most 50 per command; run it again for more. The window acts only when the user asked for the archive and the
latest message before the command is one the user typed in the steward conversation. A message from another session, a
notice, or a handoff does not count. The window does not act on a subagent's call. It archives only conversations this
steward manages, and skips any that is working, waiting for the user or running background work, or that another process
runs while the window cannot see its state. Archiving requires an Agent Plus version with the archive interface and
affects only the session lists of projects open in VS Code windows on this machine. As with Archive on a row, the
conversation leaves its group and is unpinned. It can still be opened and run, and the user can unarchive it from the
list. The script prints one line per conversation: "Archived: ..." or "Not archived: ...: <reason>". It exits 0 only if
all were archived.

A key "<source id>:<session id>" (steward_table.py) names another agent's conversation, which takes only a plain
message. The request goes to Agent Plus through the window that shows the steward, and Agent Plus sends the message as
the user's in the window where the conversation is open. Agent Plus refuses it while the conversation waits for the
user to approve a tool or answer a question.

Prints what happened and exits 0 when it was done, 1 otherwise.
"""

import glob
import json
import os
import re
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import SESSION_NAME, listed, write_atomic  # noqa: E402
from plan_common import open_tail  # noqa: E402
import plan_agent as A  # noqa: E402
from proc_alive import alive  # noqa: E402
import steward_table  # noqa: E402

RELAY_DIR = "relay"
# Claude Code Plus stops taking a request after 60 seconds; the answer panel waits up to 15 seconds for a send.
WAIT_SECONDS = 40
OPEN_WAIT_SECONDS = 50
# A resume waits for a tab to show the conversation (30 seconds), for a long one to load (up to 3 minutes) and then for
# it to take the message (20 seconds more). The script waits less, to stay inside a tool call's time; the window goes on.
RESUME_WAIT_SECONDS = 110
# Up to 5 seconds until a window's next pass takes the request, up to 6.5 more to find the steward's call, and about
# 40 for Agent Plus's deliver() to settle.
OTHER_WAIT_SECONDS = 55
TAIL_BYTES = 256 * 1024
SAID = {
    "submitted": "Sent: it was typed into the conversation's message input and sent as the user's message.",
    "notReceived": "Not sent",
    "uncertain": "Unclear whether it was sent",
    "refused": "Not sent",
}
SENT_OTHER = "Sent: it reached the conversation as the user's message."
DRAFTED = "Not sent: the text was left in the conversation's message input as a draft."
NO_ACTIONS = ("Not done: a supervisor can only send plain messages to %(label)s conversations; the user renames, closes "
              "or reopens one in %(label)s.")


WINDOWS_DIR = "windows"
# Claude Code Plus rewrites a window's entry once a minute while the window is open.
WINDOW_STALE_SECONDS = 120
FLAGS = ("--rename", "--close", "--open", "--resume", "--handoff", "--take", "--drop", "--all", "--new", "--archive")
# Agent Plus archives at most this many in one call.
ARCHIVE_MAX = 50
LIST = ("--take", "--drop", "--all", "--new")
SWITCHES = ("--all", "--new")
# Each takes the next argument.
VALUED = ("--to",) + SWITCHES
MODIFIERS = ("--confirmed", "--windows", "--anyway")
SENDS_FILE = "sends.json"
RECENT_SECONDS = 30 * 60
RECENT_CHARS = 300
TICKED = " It is now ticked for you in the Supervisor panel."
DONE = {
    "--rename": "Renamed.",
    "--close": "Closed: the conversation's tab was closed; it is not deleted and can be opened again from the session list.",
    "--open": "Opened: a new conversation was started and its first message sent.",
}
HANDED = ("Handed off to the supervisor %s: it was told, in a notice that is not the user's message. Say so in one sentence in "
          "your reply and leave it to the supervisor.")
NOT_HANDED = " Say in your reply where it seems to belong, so the user decides."
HEAD_BYTES = 64 * 1024
CWD = re.compile(r'"cwd":"((?:[^"\\]|\\.)*)"')


def windows(directory):
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


def window_lines(found):
    """The open windows and their folders, one line each, as --windows prints them."""
    return ["%s: %s" % (w.get("name") or "(untitled)", ", ".join(w.get("folders") or []) or "(no folder)") for w in found] \
        or ["No open VS Code window with Claude Code Plus was found."]


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def transcript(sid):
    hits = glob.glob(os.path.join(claude_dir(), "projects", "*", sid + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else ""


def filed_under(name, folder):
    """Whether Claude Code keeps the conversations of `folder` in `name`, a folder under projects/. Claude Code names
    that folder by turning every character but a letter or digit into a hyphen, and past 200 characters it adds a hash
    of its own."""
    fold = (lambda t: t.lower()) if sys.platform in ("win32", "darwin") else (lambda t: t)
    want, name = fold(re.sub(r"[^a-zA-Z0-9]", "-", folder or "")), fold(name or "")
    if not want or not name:
        return False
    return name == want if len(want) <= 200 else name.startswith(want[:200] + "-")


def cwds(text):
    out = []
    for m in CWD.finditer(text):
        try:
            out.append(json.loads('"%s"' % m.group(1)))
        except ValueError:
            pass
    return out


def started_in(path):
    """The folder a conversation belongs to. Its records carry cwd values, and this returns the first one Claude Code
    would keep under the projects/ folder holding the transcript. A conversation resumed in another folder is
    copied there with its old records."""
    name = os.path.basename(os.path.dirname(path))
    try:
        with open(path, "rb") as fh:
            head = cwds(fh.read(HEAD_BYTES).decode("utf-8", "replace"))
    except OSError:
        return ""
    hit = next((c for c in head if filed_under(name, c)), "")
    tail = None if hit else open_tail(path)
    if tail is not None and tail.size > HEAD_BYTES:
        hit = next((c for line in tail.lines(TAIL_BYTES) for c in reversed(cwds(line)) if filed_under(name, c)), "")
    return hit or (head[0] if head else "")


def opens_here(path, w):
    """Whether Claude Code in window `w` finds the transcript at `path`: only under its first folder, or the home folder
    for a window with none."""
    folders = listed(w.get("folders"))
    first = folders[0] if folders else os.path.expanduser("~")
    name = os.path.basename(os.path.dirname(path))
    return filed_under(name, first) or filed_under(name, os.path.realpath(first))


def shows(w, sid):
    return sid in [str(s).lower() for s in listed(w.get("sessions"))]


stewards_table = steward_table.read
manages = steward_table.manages


def resume_check(data, sid):
    """Why the conversation cannot be opened, as lines to print, or [] and the folder it was started in."""
    found = windows(data)
    showing = [w for w in found if shows(w, sid)]
    if showing:
        managed = manages(stewards_table(data), os.environ.get("CLAUDE_CODE_SESSION_ID", "").lower(), sid)
        return ['Not done: it is already open in the VS Code window "%s"; a plain send reaches it there%s.'
                % (showing[0].get("name") or "(untitled)",
                   "" if managed else " once the user ticks it for this supervisor in the Supervisor panel")], ""
    path = transcript(sid)
    if not path:
        return ["Not done: no conversation with that session id was found under %s." % os.path.join(claude_dir(), "projects")], ""
    cwd = started_in(path)
    if not cwd:
        return ["Not done: its transcript does not say which folder it was started in."], ""
    if not any(opens_here(path, w) for w in found):
        return (["Not done: no open VS Code window has its folder, %s, as its first folder, and Claude Code opens a stored "
                 "conversation only in such a window; in any other it would start a new, empty one. Ask the user to open "
                 "that folder in a window (as its first folder). The open windows:" % cwd]
                + ["  " + line for line in window_lines(found)]), cwd
    return [], cwd


def handoff_check(data, me, to=""):
    table = stewards_table(data)
    theirs = steward_table.stewards_of(table, me)
    if not theirs:
        return "Not done: no supervisor manages this conversation, so it cannot be handed off." + NOT_HANDED
    if to and to not in theirs:
        return ("Not done: %s does not manage this conversation. Its supervisors are %s."
                % (to, ", ".join(steward_table.name_of(table, s) for s in theirs)))
    if not any(shows(w, s) for w in windows(data) for s in ([to] if to else theirs)):
        return ("Not done: that supervisor is not open in a VS Code window." if to else
                "Not done: no supervisor of this conversation is open in a VS Code window, so none can be told.") + NOT_HANDED
    return ""


def recent_sends(data, target, me, now):
    """Messages other stewards sent `target` in the last RECENT_SECONDS, newest first. The window records them in
    SENDS_FILE."""
    try:
        with open(os.path.join(data, RELAY_DIR, SENDS_FILE), encoding="utf-8") as fh:
            found = json.load(fh)
    except (OSError, ValueError):
        return []
    entries = listed(found.get(target)) if isinstance(found, dict) else []
    out = [e for e in entries if isinstance(e, dict) and isinstance(e.get("at"), (int, float))
           and str(e.get("steward") or "").lower() != me and 0 <= now * 1000 - e["at"] < RECENT_SECONDS * 1000]
    return sorted(out, key=lambda e: -e["at"])


def recent_lines(sends, now):
    lines = ["Not sent: another supervisor sent this conversation a message in the last %d minutes:" % (RECENT_SECONDS // 60)]
    for e in sends:
        who = '"%s" (%s)' % (e.get("title"), e.get("steward")) if e.get("title") else str(e.get("steward"))
        minutes = int((now * 1000 - e["at"]) // 60000)
        text = " ".join(str(e.get("text") or "").split())
        lines.append("  - %s, %s: %s" % (who, "just now" if minutes < 1 else "%d minute%s ago" % (minutes, "" if minutes == 1 else "s"),
                                           text[:RECENT_CHARS] + ("..." if len(text) > RECENT_CHARS else "")))
    lines.append("If your message goes against a message above, ask the user before you send anything. Otherwise run the "
                 "same command again with --anyway.")
    return lines


def resume_said(r, name, text):
    """What a resume's answer says, and whether it was all done."""
    outcome, reason = r.get("outcome", ""), r.get("reason") or r.get("outcome", "")
    where = 'the VS Code window "%s"' % name if name else "a VS Code window"
    ticked = TICKED if r.get("ticked") is True else ""
    if outcome == "submitted":
        return ("Opened: the conversation was opened in an editor tab in %s%s%s" % (where, (
            ", and the message was typed into its input and sent as the user's message." if text else "."), ticked)), True
    if r.get("opened") is True:
        if outcome == "uncertain":
            return "Opened in an editor tab in %s, but it is unclear whether the message was sent: %s.%s" % (where, reason, ticked), False
        return "Opened in an editor tab in %s, but the message was not sent: %s.%s" % (where, reason, ticked), False
    if outcome == "uncertain":
        return "Unclear whether it was opened: %s" % reason, False
    return "Not done: %s" % reason, False


def read_input():
    # Read as bytes: on Windows the console code page would otherwise decode the message, and fail on Chinese.
    raw = sys.stdin.buffer.read()
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return raw.decode("utf-8", "replace").strip()


USAGE = ("usage: steward-relay.py [--anyway | --rename | --close [--confirmed] | --open | --resume]"
         " <session id or folder> [<plugin data directory>] < text\n"
         "       steward-relay.py --handoff [--to <supervisor session id>] [<plugin data directory>] < text\n"
         "       steward-relay.py --take | --drop <session id, key or title> [<plugin data directory>]\n"
         "       steward-relay.py --all | --new on|off [<plugin data directory>]\n"
         "       steward-relay.py --archive <session id> [<session id> ...] [<plugin data directory>]")


def archive(args):
    """--archive: the conversations named, Claude Code session ids on the command line or one a line on standard input,
    then the plugin data directory if given. The window that shows this steward archives them in Agent Plus's session
    list, each one only if this steward manages it and it is not working, waiting for the user or running background work,
    and only when the user asked for it in this steward conversation (the latest message before this command is one the
    user typed there). Prints a line for each conversation."""
    rest = [a for a in args if a != "--archive"]
    if any(a in FLAGS + MODIFIERS + VALUED for a in rest):
        print(USAGE)
        return 2
    data = rest.pop() if rest and os.path.isabs(rest[-1]) else A.FALLBACK
    names = rest or (read_input().split() if not sys.stdin.isatty() else [])
    ids = []
    for n in names:
        sid = steward_table.managed_id(n)
        if not sid or steward_table.is_other(sid):
            print("Not done: %s is not a Claude Code session id; only Claude Code conversations are archived this way." % n)
            return 1
        if sid not in ids:
            ids.append(sid)
    if not ids:
        print("Not done: no conversation was named.")
        return 1
    if len(ids) > ARCHIVE_MAX:
        print("Not done: %d conversations were named; give at most %d at a time." % (len(ids), ARCHIVE_MAX))
        return 1
    steward = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not SESSION_NAME.match(steward):
        print("Not done: CLAUDE_CODE_SESSION_ID is not set, so this was not run from the supervisor conversation.")
        return 1
    directory = os.path.join(data, RELAY_DIR)
    os.makedirs(directory, exist_ok=True)
    rid = str(uuid.uuid4())
    request_file = os.path.join(directory, rid + ".json")
    result = os.path.join(directory, rid + ".result.json")
    write_atomic(request_file, json.dumps({"id": rid, "action": "archive", "to": ids[0], "ids": ids, "text": "",
                                           "steward": steward.lower(), "at": int(time.time() * 1000)}))
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        if os.path.exists(result):
            try:
                with open(result, encoding="utf-8") as fh:
                    r = json.load(fh)
            except (OSError, ValueError):
                time.sleep(0.2)
                continue
            try:
                os.remove(result)
            except OSError:
                pass
            each = [e for e in listed(r.get("results")) if isinstance(e, dict)]
            if not each:
                print("Not done: %s." % (r.get("reason") or r.get("outcome") or "no answer"))
                return 1
            for e in each:
                sid = str(e.get("sessionId") or "")
                who = '"%s" (%s)' % (e.get("title"), sid) if e.get("title") else sid
                if e.get("outcome") == "archived":
                    print("Archived: %s." % who)
                else:
                    print("Not archived: %s: %s." % (who, e.get("reason") or e.get("outcome") or "no reason given"))
            return 0 if all(e.get("outcome") == "archived" for e in each) else 1
        time.sleep(0.25)
    try:
        os.remove(request_file)
        print("Not done: no VS Code window that shows this supervisor conversation took the request.")
    except OSError:
        print("Unclear whether it was done: a window took the request but gave no answer in time.")
    return 1


def main(argv):
    args = argv[1:]
    if "--archive" in args:
        return archive(args)
    action = next((a for a in args if a in FLAGS), "")
    confirmed = "--confirmed" in args
    listing = "--windows" in args
    anyway = "--anyway" in args
    valued, rest, i, bad = {}, [], 0, False
    while i < len(args):
        a = args[i]
        if a in VALUED:
            if i + 1 >= len(args) or a in valued:
                bad = True
            else:
                valued[a] = args[i + 1]
            i += 2
            continue
        if a not in FLAGS + MODIFIERS:
            rest.append(a)
        i += 1
    if listing:
        for line in window_lines(windows(rest[0] if rest else A.FALLBACK)):
            print(line)
        return 0
    handing = action == "--handoff"
    switching = action in SWITCHES
    naming = action in ("--take", "--drop")
    to_steward = valued.get("--to", "")
    named = " ".join(read_input().split()) if naming and not sys.stdin.isatty() else ""
    # With --handoff, --all, --new, or a conversation named in a here-document, the first argument, if any, is the
    # plugin data directory.
    if handing or switching or named:
        rest = [""] + rest
    target = named or (rest[0] if rest else "")
    opening = action == "--open"
    if bad or (opening and not os.path.isabs(target)) \
            or (not opening and not handing and not switching and not naming and not steward_table.managed_id(target)) \
            or (confirmed and action != "--close") or len([a for a in args if a in FLAGS]) > 1 or len(rest) > 2 \
            or (switching and valued.get(action) not in ("on", "off")) or ("--to" in valued and not handing) \
            or (to_steward and not SESSION_NAME.match(to_steward)) or (anyway and action not in ("", "--resume")):
        print(USAGE)
        return 2
    other = not opening and not handing and not switching and not naming and steward_table.is_other(steward_table.managed_id(target))
    if other and not steward_table.allowed(target):
        print("Not done: a supervisor cannot send to conversations of %s." % steward_table.label_of(target))
        return 1
    if other and action:
        print(NO_ACTIONS % {"label": steward_table.label_of(target)})
        return 1
    steward = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not SESSION_NAME.match(steward):
        print("Not done: CLAUDE_CODE_SESSION_ID is not set, so this was not run from a Claude Code conversation."
              if action == "--handoff" else
              "Not done: CLAUDE_CODE_SESSION_ID is not set, so this was not run from the supervisor conversation.")
        return 1
    resuming = action == "--resume"
    text = ""
    # A resume's message is optional, and a terminal would wait for one.
    if action not in ("--close",) + LIST and not (resuming and sys.stdin.isatty()):
        text = read_input()
    if not text and action not in ("--close", "--resume") + LIST:
        print("Not done: nothing on standard input.")
        return 1
    if naming and not target:
        print("Not done: no conversation was named.")
        return 1
    data = rest[1] if len(rest) > 1 else A.FALLBACK
    target = target if opening or naming else valued[action] if switching else to_steward.lower() if handing \
        else steward_table.managed_id(target)
    cwd = ""
    if text and action in ("", "--resume") and not anyway:
        found = recent_sends(data, target, steward.lower(), time.time())
        if found:
            print("\n".join(recent_lines(found, time.time())))
            return 1
    if resuming:
        said, cwd = resume_check(data, target)
        if said:
            print("\n".join(said))
            return 1
    elif handing:
        said = handoff_check(data, steward.lower(), target)
        if said:
            print(said)
            return 1
    directory = os.path.join(data, RELAY_DIR)
    os.makedirs(directory, exist_ok=True)
    rid = str(uuid.uuid4())
    request = {"id": rid, "action": action[2:] if action else "send", "to": target, "text": text,
               "at": int(time.time() * 1000)}
    request["from" if action == "--handoff" else "steward"] = steward.lower()
    if confirmed:
        request["confirmed"] = True
    request_file = os.path.join(directory, rid + ".json")
    result = os.path.join(directory, rid + ".result.json")
    write_atomic(request_file, json.dumps(request, ensure_ascii=False))
    # An open also waits for the new tab to send its first message, and a resume for the panel to show the conversation.
    deadline = time.time() + (RESUME_WAIT_SECONDS if resuming else OPEN_WAIT_SECONDS if opening
                              else OTHER_WAIT_SECONDS if other else WAIT_SECONDS)
    while time.time() < deadline:
        if os.path.exists(result):
            try:
                with open(result, encoding="utf-8") as fh:
                    r = json.load(fh)
            except (OSError, ValueError):
                time.sleep(0.2)
                continue
            try:
                os.remove(result)
            except OSError:
                pass
            outcome = r.get("outcome", "")
            reason = r.get("reason") or ""
            if resuming:
                name = next((w.get("name") or "(untitled)" for w in windows(data) if w.get("pid") == r.get("window")), "")
                line, done = resume_said(r, name, text)
                print(line)
                return 0 if done else 1
            if handing:
                sid = r.get("steward") or ""
                if outcome == "submitted":
                    print(HANDED % ('"%s" (%s)' % (r.get("stewardTitle"), sid) if r.get("stewardTitle") else sid or "(unknown)"))
                    return 0
                print("Not done: %s.%s" % (reason or outcome, NOT_HANDED))
                return 1
            if action in LIST:
                print("%s: %s." % ("Done" if outcome == "submitted" else "Not done", reason or outcome))
                return 0 if outcome == "submitted" else 1
            if outcome == "submitted":
                print(DONE.get(action, SENT_OTHER if other else SAID["submitted"]) + (TICKED if r.get("ticked") is True else ""))
                if opening:
                    sid = r.get("sessionId") or ""
                    print("Session id: %s" % sid if sid else "Its session id was not known yet; it is in the Supervisor panel.")
                return 0
            if outcome == "drafted" and not action:
                print(DRAFTED)
                return 1
            line = SAID.get(outcome, "Not sent") if not action else ("Not done" if outcome != "uncertain" else SAID["uncertain"])
            print("%s: %s" % (line, reason or outcome))
            return 1
        time.sleep(0.25)
    try:
        os.remove(request_file)
        if opening:
            print("Not done: no VS Code window whose first folder is that folder took the request. Run --windows to see the "
                  "open ones.")
        elif resuming:
            print("Not done: no VS Code window whose first folder is its folder, %s, took the request. The open windows:" % cwd)
            for line in window_lines(windows(data)):
                print("  " + line)
        elif handing:
            print("Not done: no VS Code window that shows a supervisor of this conversation took the request." + NOT_HANDED)
        elif action in LIST:
            print("Not done: no VS Code window that shows this supervisor conversation took the request.")
        elif other:
            print("Not done: no VS Code window that shows this supervisor conversation took the request.")
        else:
            print("Not done: no VS Code window that shows that conversation took the request. If no window has it open, "
                  "--resume opens it.")
    except OSError:
        if resuming:
            taker = next((n.rsplit("-", 1)[1] for n in os.listdir(directory) if n.startswith(rid + ".taken-")), "")
            name = next((w.get("name") or "(untitled)" for w in windows(data) if str(w.get("pid")) == taker), "")
            print('Still opening: %s took the request and is opening the conversation; a long one can take a few minutes '
                  "to load, and %s. Check later with --windows that a window shows it."
                  % ('the VS Code window "%s"' % name if name else "a VS Code window",
                     "the message is typed into it once it has" if text else "nothing more is needed"))
        else:
            print("Unclear whether it was done: a window took the request but gave no answer in time.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
