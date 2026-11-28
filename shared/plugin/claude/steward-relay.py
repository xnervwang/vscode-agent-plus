#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/steward-relay.py; sync-shared.js copies it, so edit it there.

"""A steward's requests for the conversations it manages.

    python3 steward-relay.py <session id> [<plugin data directory>] <<'EOF'
    <the message, worded for that conversation>
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
    python3 steward-relay.py --handoff [<plugin data directory>] <<'EOF'
    <the user's words, where they should go, and why>
    EOF
    python3 steward-relay.py --take-lead <session id or key> --ask [<plugin data directory>]
    python3 steward-relay.py --take-lead <session id or key> [<plugin data directory>]
    python3 steward-relay.py --hand-over <session id or key> [<plugin data directory>] <<'EOF'
    <a short note for it: what you had asked it to do, and that the other supervisor takes over>
    EOF
    python3 steward-relay.py --take <session id, key or exact title> [<plugin data directory>]
    python3 steward-relay.py --drop <session id, key or exact title> [<plugin data directory>]
    python3 steward-relay.py --all on|off [<plugin data directory>]
    python3 steward-relay.py --new on|off [<plugin data directory>]
    python3 steward-relay.py --archive <session id> [<session id> ...] [<plugin data directory>]

Run from the steward conversation: its session id comes from CLAUDE_CODE_SESSION_ID. Claude Code Plus types the
message into that conversation's input in the VS Code window that has it open and sends it, so it arrives as the
user's own message, approvals included, after a first line naming this steward. The window first looks for this
command in the steward's transcript, so give the message in a here-document as above.

Of the stewards that manage a conversation, only its lead acts on it: sends it messages, renames, closes, resumes or
archives it. The others observe it. Each request carries the conversation's lead term as stewards.json gives it now
(steward_table.py) and a sequence number one above the highest of the requests for it in the relay folder, and it is
written as <id>.v4.json, a name that windows of older builds do not take. Right before it acts, the window refuses a
request when this steward does not lead the conversation or the lead changed after the request was written; the
script prints its reason as it is. When another steward leads the conversation, the script prints that reason itself
and writes no request.

--take-lead <key> --ask is for an observer the window refused: the window notes the question and answers with one for
the user, which the script prints with what to do: ask the user exactly that and end the turn. Only when the user's
next message clearly agrees, run --take-lead <key> without --ask. If the lead is open in a window, the window asks it
to hand the conversation over; otherwise this steward leads it at once. --hand-over <key> is run by the lead the user
agreed to replace, with a short note on standard input: the window sends it to the conversation after a first line of
its own, and the other steward leads the conversation from then on.

--rename gives the conversation a new title. --close closes its editor tab; the conversation is not deleted and can be
opened again from the session list. A conversation that is working, waiting for an answer or running background work is
closed only with --confirmed. --open starts a new conversation in the VS Code window whose first folder is <folder>,
sends it the message and prints its session id, or says that no window has the folder open. This steward leads the
conversation it opens.
--windows prints the open windows and their folders.

--resume opens a conversation that no window shows, in an editor tab of the VS Code window whose first folder is the one
Claude Code keeps the conversation under, since Claude Code finds a window's stored conversations only there, and then
sends it the message, if one is given. It is not done while a window shows the conversation or another process runs it;
it says which. Only the lead resumes a conversation, or any steward when it has none, which then leads it. A
conversation opened with --open or --resume is ticked for this steward in the Supervisor panel; the printed answer
mentions the tick.

--handoff is run from a conversation a steward manages, not from the steward: it gives its lead something the
conversation thinks belongs elsewhere, as a notice that is not the user's message. It is refused when no steward leads
the conversation or its lead is not open in a VS Code window. --to and --anyway are gone; the script says so.

--take and --drop tick or untick one conversation for this steward in the Supervisor panel, named by its session id, its
key, or its exact title (in a here-document instead, when it is awkward in a command line). --all turns "All, including
new ones" on or off, and --new "New conversations". The window that shows the steward makes the change only when the
latest message before this command in the steward conversation is one the user typed there; otherwise it prints why.

--archive <session id> [<session id> ...] [<plugin data directory>] asks the window showing the steward to archive the
named conversations in Agent Plus's session list. You can also give the session ids one per line in a here-document.
Give at most 50 per command; run it again for more. The window acts only when the user asked for the archive: the
latest message before the command must be one the user typed in the steward conversation, not a message from another
session, a notice or a handoff, and the command must not come from a subagent. It archives only conversations this
steward leads, and skips any that is working, waiting for the user or running background work, or that another process
runs while the window cannot see its state. Archiving requires an Agent Plus version with the archive interface and
affects only the session lists of projects open in VS Code windows on this machine. As with Archive on a row, the
conversation leaves its group and is unpinned. It can still be opened and run, and the user can unarchive it from the
list. The script prints one line per conversation: "Archived: ..." or "Not archived: ...: <reason>". It exits 0 only if
all were archived.

A key "<source id>:<session id>" (steward_table.py) names another agent's conversation, which takes only a plain
message from its lead, and --take-lead and --hand-over. The request goes to Agent Plus through the window that shows
the steward, and Agent Plus sends the message as the user's in the window where the conversation is open. Agent Plus
refuses it while the conversation waits for the user to approve a tool or answer a question.

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


WINDOWS_DIR = steward_table.WINDOWS_DIR
FLAGS = ("--rename", "--close", "--open", "--resume", "--handoff", "--take", "--drop", "--all", "--new", "--archive",
         "--take-lead", "--hand-over")
# Agent Plus archives at most this many in one call.
ARCHIVE_MAX = 50
LIST = ("--take", "--drop", "--all", "--new")
SWITCHES = ("--all", "--new")
# Each takes the next argument.
VALUED = SWITCHES
MODIFIERS = ("--confirmed", "--windows", "--ask")
# Flags this script no longer takes, after their "--", and what passing one is told.
GONE = {
    "anyway": "only a conversation's lead sends it messages, so no other supervisor's message holds yours back",
    "to": "a hand-off always goes to the conversation's lead supervisor",
}
# Windows of older builds take only <id>.json, so they never run a request that carries a lead term.
REQUEST_SUFFIX = ".v4.json"
RESULT_SUFFIX = ".result.json"
TICKED = " It is now ticked for you in the Supervisor panel."
LEADS = " You are its lead supervisor."
DONE = {
    "--rename": "Renamed.",
    "--close": "Closed: the conversation's tab was closed; it is not deleted and can be opened again from the session list.",
    "--open": "Opened: a new conversation was started and its first message sent.",
}
HANDED = ("Handed off to your lead supervisor %s: it was told, in a notice that is not the user's message. Say so in one "
          "sentence in your reply and leave it to the supervisor.")
NOT_HANDED = " Say in your reply where it seems to belong, so the user decides."
# A window of an older build shows the conversation but leaves a <id>.v4.json request alone.
OLD_BUILD = (' The VS Code window "%s" shows it but took no request; it may run an older build of Claude Code Plus, which does '
             "not take requests from this one. Ask the user to reload that window.")
HEAD_BYTES = 64 * 1024
CWD = re.compile(r'"cwd":"((?:[^"\\]|\\.)*)"')


windows = steward_table.open_windows


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


def title(table, key):
    """How the window names conversation `key` in its reasons: the title the table records, else the key."""
    return steward_table.title_of(table, key) or key


def not_lead(table, me, key):
    """The window's reason for refusing what steward `me` asks of `key` when another steward leads it and `me` only
    observes it, or "" when `me` leads it, manages it not at all, or nobody leads it in the table read now."""
    lead = steward_table.lead_of(table, key)
    if steward_table.role_of(table, me, key) != "observer" or not lead:
        return ""
    pending = (steward_table.lead_entry(table, key) or {}).get("pending") or {}
    old = steward_table.name_of(table, lead)
    if pending.get("to") == me:
        return '"%s" is being handed over from %s to you; wait for %s\'s hand-over.' % (title(table, key), old, old)
    return ('"%s" is led by %s; you observe it. To act on it, run steward-relay.py --take-lead %s --ask and ask the user.'
            % (title(table, key), old, key))


def resume_check(data, sid):
    """Why the conversation cannot be opened, as lines to print, or [] and the folder it was started in."""
    found = windows(data)
    showing = [w for w in found if shows(w, sid)]
    if showing:
        # A steward that observes it was told so before this check.
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


def handoff_check(data, me):
    """(why the hand-off cannot be made, or "", the lead it goes to)."""
    table = stewards_table(data)
    if not steward_table.stewards_of(table, me):
        return "Not done: no supervisor manages this conversation, so it cannot be handed off." + NOT_HANDED, ""
    lead = steward_table.lead_of(table, me)
    if not lead:
        return "Not done: no supervisor leads this conversation now, so it cannot be handed off." + NOT_HANDED, ""
    if not any(shows(w, lead) for w in windows(data)):
        return "Not done: its lead supervisor is not open in a VS Code window, so it cannot be told." + NOT_HANDED, lead
    return "", lead


def take_lead_check(table, me, key, asking):
    """Why --take-lead cannot go ahead as the table stands, as (line, exit code), or None to ask the window."""
    t = title(table, key)
    if steward_table.lead_of(table, key) == me:
        return 'You already lead "%s"; act on it as the user asked.' % t, 0
    if asking or getattr(table, "version", 0) < 4:
        return None
    again = " Ask the user again with --take-lead %s --ask." % key
    pending = (steward_table.lead_entry(table, key) or {}).get("pending") or {}
    lead = steward_table.lead_of(table, key)
    if pending and lead:
        old = steward_table.name_of(table, lead)
        if pending.get("to") == me:
            return '"%s" is being handed over from %s to you; wait for %s\'s hand-over.' % (t, old, old), 0
        return 'Not done: "%s" is being handed over from %s to %s.' % (t, old, steward_table.name_of(table, pending.get("to"))), 1
    ticket = getattr(table, "tickets", {}).get(me + " " + key)
    if not ticket:
        return 'Not done: you have not asked the user whether to take over "%s".%s' % (t, again), 1
    if time.time() * 1000 - ticket["at"] >= steward_table.TICKET_SECONDS * 1000:
        return 'Not done: you asked the user about taking over "%s" more than 30 minutes ago.%s' % (t, again), 1
    if ticket["term"] != steward_table.term_of(table, key):
        return 'Not done: the lead of "%s" changed after you asked the user.%s' % (t, again), 1
    return None


def hand_over_check(table, me, key):
    """The window's reason for refusing a hand-over of `key` from `me`, when the table shows another steward is the
    lead handing it over, or ""."""
    e = steward_table.lead_entry(table, key) or {}
    lead = steward_table.lead_of(table, key)
    if not e.get("pending") or not lead or lead == me:
        return ""
    return "Only %s, the lead handing \"%s\" over, can send its hand-over." % (steward_table.name_of(table, lead), title(table, key))


def next_seq(directory, target):
    """One more than the highest sequence number among the requests for `target` still in the relay folder, taken,
    being carried out or not. Best effort: a request written at the same moment can get the same number, and the window then orders by time."""
    top = 0
    try:
        names = os.listdir(directory)
    except OSError:
        return 1
    for name in names:
        if name.endswith(RESULT_SUFFIX) or name.endswith(".tmp") or not (name.endswith(".json") or ".taken-" in name or ".doing-" in name):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                r = json.load(fh)
        except (OSError, ValueError):
            continue
        seq = r.get("seq") if isinstance(r, dict) and r.get("to") == target else None
        if isinstance(seq, int) and not isinstance(seq, bool) and seq > top:
            top = seq
    return top + 1


def old_build(data, sid):
    """OLD_BUILD for the first window that shows `sid`, or "" when none does."""
    name = next((w.get("name") or "(untitled)" for w in windows(data) if shows(w, sid)), None)
    return OLD_BUILD % name if name is not None else ""


def taken_by(directory, rid):
    """The pid of the window that took request `rid`, from the name it renamed the request to, or ""."""
    try:
        names = os.listdir(directory)
    except OSError:
        return ""
    return next((n.rsplit("-", 1)[1] for n in names if n.startswith(rid + ".") and ".taken-" in n), "")


def resume_said(r, name, text):
    """What a resume's answer says, and whether it was all done."""
    outcome, reason = r.get("outcome", ""), r.get("reason") or r.get("outcome", "")
    where = 'the VS Code window "%s"' % name if name else "a VS Code window"
    ticked = (TICKED if r.get("ticked") is True else "") + LEADS
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


USAGE = ("usage: steward-relay.py [--rename | --close [--confirmed] | --open | --resume]"
         " <session id or folder> [<plugin data directory>] < text\n"
         "       steward-relay.py --handoff [<plugin data directory>] < text\n"
         "       steward-relay.py --take-lead <session id or key> [--ask] [<plugin data directory>]\n"
         "       steward-relay.py --hand-over <session id or key> [<plugin data directory>] < note\n"
         "       steward-relay.py --take | --drop <session id, key or title> [<plugin data directory>]\n"
         "       steward-relay.py --all | --new on|off [<plugin data directory>]\n"
         "       steward-relay.py --archive <session id> [<session id> ...] [<plugin data directory>]")


def gone(args):
    """The usage error for a flag this script no longer takes, or ""."""
    flag = next((a[2:] for a in args if a.startswith("--") and a[2:] in GONE), "")
    return "usage error: --%s is gone: %s.\n%s" % (flag, GONE[flag], USAGE) if flag else ""


def write_request(directory, request):
    """Write `request` with its id, lead term and sequence number; (request file, result file)."""
    os.makedirs(directory, exist_ok=True)
    request["seq"] = next_seq(directory, request["to"])
    request_file = os.path.join(directory, request["id"] + REQUEST_SUFFIX)
    write_atomic(request_file, json.dumps(request, ensure_ascii=False))
    return request_file, os.path.join(directory, request["id"] + RESULT_SUFFIX)


def archive(args):
    """--archive, as the paragraph about it at the top of this file says."""
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
            print("Not done: %s is not a Claude Code session id." % n)
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
    table = stewards_table(data)
    refused = [(sid, not_lead(table, steward.lower(), sid)) for sid in ids]
    for sid, why in refused:
        if why:
            t = steward_table.title_of(table, sid)
            print("Not archived: %s: %s" % ('"%s" (%s)' % (t, sid) if t else sid, why))
    ids = [sid for sid, why in refused if not why]
    if not ids:
        return 1
    directory = os.path.join(data, RELAY_DIR)
    rid = str(uuid.uuid4())
    request_file, result = write_request(directory, {
        "id": rid, "action": "archive", "to": ids[0], "ids": ids, "text": "", "steward": steward.lower(),
        "term": steward_table.term_of(table, ids[0]), "terms": {sid: steward_table.term_of(table, sid) for sid in ids},
        "at": int(time.time() * 1000)})
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
                    print("Not archived: %s: %s" % (who, end(e.get("reason") or e.get("outcome") or "no reason given")))
            return 0 if all(e.get("outcome") == "archived" for e in each) and len(each) == len(refused) else 1
        time.sleep(0.25)
    try:
        os.remove(request_file)
        print("Not done: no VS Code window that shows this supervisor conversation took the request."
              + old_build(data, steward.lower()))
    except OSError:
        print("Unclear whether it was done: a window took the request but gave no answer in time.")
    return 1


def end(reason):
    """`reason` as the end of a sentence: the window's reasons end with their own full stop, older ones do not."""
    reason = str(reason).rstrip()
    return reason if reason.endswith((".", "?", "!")) else reason + "."


def take_lead_said(r, table, key):
    """What the window's answer to --take-lead says, and whether it was done."""
    outcome, t = r.get("outcome", ""), title(table, key)
    if outcome == "ask" and isinstance(r.get("question"), str) and r["question"].strip():
        return ("Ask the user exactly this, word for word, and end your turn without acting on the conversation:\n\n%s\n\n"
                "Only a clear yes in the user's next message counts. Then run steward-relay.py --take-lead %s, without "
                "--ask. If the answer is no, or unclear, take nothing over and say so in one line." % (r["question"].strip(), key)), True
    if outcome == "pending":
        lead = str(r.get("lead") or "").lower()
        who = '"%s" (%s)' % (r.get("leadTitle"), lead) if r.get("leadTitle") else steward_table.name_of(table, lead) if lead else "its lead"
        return ('Agreed: %s is asked to hand "%s" over to you, and leads it until then, at most 10 minutes. A notice tells '
                "you when you lead it; send it nothing before that." % (who, t)), True
    if outcome == "lead":
        return ('You lead "%s" now. A notice asks you to send it a first message saying so; send that first, then go on '
                "with what the user asked." % t), True
    return "Not done: %s" % end(r.get("reason") or outcome or "no answer"), False


def hand_over_said(r, table, key):
    """What the window's answer to --hand-over says, and whether it was done."""
    outcome, t = r.get("outcome", ""), title(table, key)
    to = str(r.get("lead") or ((steward_table.lead_entry(table, key) or {}).get("pending") or {}).get("to") or "").lower()
    who = '"%s" (%s)' % (r.get("leadTitle"), to) if r.get("leadTitle") else steward_table.name_of(table, to) if to else "the other supervisor"
    if outcome == "submitted":
        return 'Handed over: the note was sent to "%s", and %s leads it now; you observe it.' % (t, who), True
    if outcome == "kept":
        return ('Handed over: "%s" is not open in a VS Code window, so it is shown the note at its next turn; %s leads it '
                "now and you observe it." % (t, who)), True
    if outcome == "uncertain":
        return "Unclear whether it was handed over: %s" % end(r.get("reason") or outcome), False
    return "Not done: %s" % end(r.get("reason") or outcome or "no answer"), False


def main(argv):
    args = argv[1:]
    said = gone(args)
    if said:
        print(said)
        return 2
    if "--archive" in args:
        return archive(args)
    action = next((a for a in args if a in FLAGS), "")
    confirmed = "--confirmed" in args
    listing = "--windows" in args
    asking = "--ask" in args
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
    taking = action == "--take-lead"
    giving = action == "--hand-over"
    named = " ".join(read_input().split()) if naming and not sys.stdin.isatty() else ""
    # With --handoff, --all, --new, or a conversation named in a here-document, the first argument, if any, is the
    # plugin data directory.
    if handing or switching or named:
        rest = [""] + rest
    target = named or (rest[0] if rest else "")
    opening = action == "--open"
    if bad or (opening and not os.path.isabs(target)) \
            or (not opening and not handing and not switching and not naming and not steward_table.managed_id(target)) \
            or (confirmed and action != "--close") or (asking and not taking) or len([a for a in args if a in FLAGS]) > 1 \
            or len(rest) > 2 or (switching and valued.get(action) not in ("on", "off")):
        print(USAGE)
        return 2
    other = not opening and not handing and not switching and not naming and steward_table.is_other(steward_table.managed_id(target))
    if other and not steward_table.allowed(target):
        print("Not done: a supervisor cannot send to conversations of %s." % steward_table.label_of(target))
        return 1
    if other and action and not taking and not giving:
        print(NO_ACTIONS % {"label": steward_table.label_of(target)})
        return 1
    steward = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not SESSION_NAME.match(steward):
        print("Not done: CLAUDE_CODE_SESSION_ID is not set, so this was not run from a Claude Code conversation."
              if action == "--handoff" else
              "Not done: CLAUDE_CODE_SESSION_ID is not set, so this was not run from the supervisor conversation.")
        return 1
    me = steward.lower()
    resuming = action == "--resume"
    text = ""
    # A resume's message is optional, and a terminal would wait for one.
    if action not in ("--close", "--take-lead") + LIST and not (resuming and sys.stdin.isatty()):
        text = read_input()
    if not text and action not in ("--close", "--resume", "--take-lead") + LIST:
        print("Not done: nothing on standard input.")
        return 1
    if naming and not target:
        print("Not done: no conversation was named.")
        return 1
    data = rest[1] if len(rest) > 1 else A.FALLBACK
    target = target if opening or naming else valued[action] if switching else "" if handing \
        else steward_table.managed_id(target)
    table = stewards_table(data)
    # Only the actions on a conversation are refused for an observer; a list change is the steward's own.
    acting = not opening and not handing and not naming and not switching
    cwd = ""
    if acting and not taking and not giving:
        refused = not_lead(table, me, target)
        if refused:
            print("%s: %s" % ("Not sent" if not action else "Not done", refused))
            return 1
    if taking:
        said = take_lead_check(table, me, target, asking)
        if said:
            print(said[0])
            return said[1]
    if giving:
        refused = hand_over_check(table, me, target)
        if refused:
            print("Not done: " + refused)
            return 1
    if resuming:
        said, cwd = resume_check(data, target)
        if said:
            print("\n".join(said))
            return 1
    elif handing:
        said, target = handoff_check(data, me)
        if said:
            print(said)
            return 1
    rid = str(uuid.uuid4())
    request = {"id": rid, "action": action[2:] if action else "send", "to": target, "text": text,
               "at": int(time.time() * 1000)}
    request["from" if action == "--handoff" else "steward"] = me
    if acting or handing:
        request["term"] = steward_table.term_of(table, me if handing else target)
    if taking:
        request["ask"] = asking
    if confirmed:
        request["confirmed"] = True
    directory = os.path.join(data, RELAY_DIR)
    request_file, result = write_request(directory, request)
    # An open also waits for the new tab to send its first message, and a resume for the panel to show the conversation.
    deadline = time.time() + (RESUME_WAIT_SECONDS if resuming else OPEN_WAIT_SECONDS if opening
                              else OTHER_WAIT_SECONDS if other and not taking else WAIT_SECONDS)
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
            if taking or giving:
                line, done = (take_lead_said if taking else hand_over_said)(r, table, target)
                print(line)
                return 0 if done else 1
            if handing:
                sid = r.get("steward") or target
                if outcome == "submitted":
                    print(HANDED % ('"%s" (%s)' % (r.get("stewardTitle"), sid) if r.get("stewardTitle") else sid or "(unknown)"))
                    return 0
                print("Not done: %s%s" % (end(reason or outcome), NOT_HANDED))
                return 1
            if action in LIST:
                print("%s: %s" % ("Done" if outcome == "submitted" else "Not done", end(reason or outcome)))
                return 0 if outcome == "submitted" else 1
            if outcome == "submitted":
                print(DONE.get(action, SENT_OTHER if other else SAID["submitted"]) + (TICKED if r.get("ticked") is True else "")
                      + (LEADS if opening else ""))
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
            print("Not done: no VS Code window that shows its lead supervisor took the request." + old_build(data, target)
                  + NOT_HANDED)
        elif action in LIST or other or taking or giving:
            print("Not done: no VS Code window that shows this supervisor conversation took the request." + old_build(data, me))
        else:
            older = old_build(data, target)
            print("Not done: no VS Code window that shows that conversation took the request."
                  + (older or " If no window has it open, --resume opens it."))
    except OSError:
        if resuming:
            taker = taken_by(directory, rid)
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
