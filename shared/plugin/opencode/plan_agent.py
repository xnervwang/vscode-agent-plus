# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/opencode/plan_agent.py; sync-shared.js copies it, so edit it there.

"""The OpenCode side of the work plan hooks, run by the OpenCode Agent Plus extension's plugin: where the plans are, how
the plugin's turn record is read, and what the model is told to change rows with. plan_common.py imports this module,
which imports nothing from the plugin.

OpenCode has no hook commands and no transcript file. Its plugin (opencode-plugin/agent-work-plan/index.js in the OpenCode
Plus repository) runs these scripts itself, with the plans folder as the first argument and the event on standard
input, the same as a hook. Where a script reads a transcript, the plugin writes a short one for the occasion: the turn
it is about, one JSON object per line, in the shape fixture_* below write.

  {"type": "user_message", "timestamp": TIME, "text": TEXT}
  {"type": "tool_call", "timestamp": TIME, "name": TOOL, "input": {...}}
  {"type": "assistant_text", "timestamp": TIME, "text": TEXT}
  {"type": "usage", "timestamp": TIME, "tokens": N, "window": N}

The model changes rows with the plugin's set_row, add_row, set_summary and set_status tools on OpenCode 2, and with the
row command from a shell where the plugin cannot add tools. The plugin says which in OPENCODE_AGENT_PLUS_PLAN_TOOLS
("tools" or "shell").
"""
import json
import os
import re

AGENT = "OpenCode"
SETTING_PREFIX = "opencodeAgentPlus"


def opencode_agent_plus_home():
    """The extension's folder (paths.root() there): OPENCODE_AGENT_PLUS_HOME, else ~/.opencode-agent-plus. The plugin
    runs these scripts with the extension's OPENCODE_AGENT_PLUS_HOME in their environment."""
    return os.environ.get("OPENCODE_AGENT_PLUS_HOME") or os.path.join(os.path.expanduser("~"), ".opencode-agent-plus")


# The folder for a caller started without one as its first argument: the extension's own plans folder
# (paths.plansDir() there).
DATA_ENV = ()
FALLBACK = os.path.join(opencode_agent_plus_home(), "plans")

EXTRA_DEFAULTS = {}

# An OpenCode session id: "ses_" and letters and digits, 26 of them on OpenCode 1 and 2 alike; the range leaves room for
# another length. Nothing else the hooks keep in the plans folder starts with "ses_".
SESSION_ID = r"ses_[0-9A-Za-z]{8,64}"
# The hooks' self-tests name their conversations with ids made from this one.
EXAMPLE_SESSION_ID = "ses_df3c28ab2ffe0TYFbXAnoBpqy6"

# The field of a hook's input that names the turn: the id of the user message that began it.
TURN_FIELD = "turn_id"

# OpenCode names no conversation in a shell command's environment; its conversations rename themselves with the
# plugin's set_title tool, which knows the session it runs in (retitle.py says so when run there).
SELF_ENV = ""
NO_GROUPING = "OpenCode keeps its sessions in a database, so there is no transcript path to group by"

TOOLS = os.environ.get("OPENCODE_AGENT_PLUS_PLAN_TOOLS", "tools") != "shell"
PLAN_TOOLS = ("set_row", "add_row", "set_summary", "set_status")


def _row(line, kind):
    if '"%s"' % kind not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    return row if isinstance(row, dict) and row.get("type") == kind else None


def reply_text(line):
    """The text of an assistant reply on a turn record line, or None for any other line."""
    row = _row(line, "assistant_text")
    return str(row.get("text") or "") if row else None


def usage_of(line):
    row = _row(line, "usage")
    value = row.get("tokens") if row else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def window_of(line):
    row = _row(line, "usage")
    value = row.get("window") if row else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


"""How the injected block and the reminders tell the model to change rows."""
WAITING_ON_WORD = "waiting_on" if TOOLS else "--waiting-on"
QUESTION_WORD = "question" if TOOLS else "--question"
NOTE_WORD = "note" if TOOLS else "--note"
SESSION_HINT = "If a subagent you started is working on it, set the row to doing."
READ_HINT = "Read it with a tool"


def _command(path):
    from plan_common import row_command
    return row_command(path)


def row_help(path, command, quoted):
    """The injected block's lines on how to change a row of the plan at `path`; `command` is the row command for it."""
    if TOOLS:
        return ["To change a row, call the set_row tool (row, and any of state, note, detail, waiting_on and question); "
                "to add one, add_row (state and title, and any of under, note, waiting_on and question). Both work on "
                "this conversation's plan, read the clock themselves and need no approval. Send them in the same reply "
                "as the tool call they go with, not in a reply of their own: a reply that holds only a plan call costs a "
                "whole model call."]
    return ["To change a row, run: %s set <row> <state> [--note TEXT] [--waiting-on WHO] [--question TEXT]. To add one: "
            "%s add <state> TITLE [--under <row>] [--waiting-on WHO] [--question TEXT]. Both read the clock "
            "themselves.%s" % (command, command, " In PowerShell, put & and a space in front of either command line."
                               if quoted else "")]


def row_gist(path, command):
    """The few words on changing a row that the injected block gives on a turn when it leaves row_help out."""
    if TOOLS:
        return "the set_row or add_row tool"
    return "%s set <row> <state>, or add <state> TITLE" % command


def fixture_reply(text):
    return json.dumps({"type": "assistant_text", "timestamp": "2026-01-01T00:00:00Z", "text": text})


def fixture_tool_call():
    return json.dumps({"type": "tool_call", "timestamp": "2026-01-01T00:00:01Z", "name": "bash", "input": {}})


# A call to one of CHANGING_TOOLS always counts as a change; a call to SHELL_TOOLS counts when its command does
# (changes.py). OpenCode's own names for its file editors and its shell; Bash is the name the shared self-tests give a
# shell call.
CHANGING_TOOLS = ("edit", "write", "patch", "apply_patch", "multiedit")
SHELL_TOOLS = ("Bash", "bash", "shell")


"""The user's time zone (tell-time-zone.py). OpenCode does not tell the model the user's zone."""
TOLD_BY = "opencode"


def agent_told(tail, zone):
    return False


def fixture_usage(tokens):
    return json.dumps({"type": "usage", "timestamp": "2026-01-01T00:00:00Z", "tokens": tokens, "window": 200000})


def fixture_agent_told(zone):
    return ""


def fixture_compacted():
    return ""


"""Reading a turn back from the turn record, and speaking at its end (nudge-work-plan.py)."""
MAYBE_CALL = ('"tool_call"',)
MAYBE_USER = ('"user_message"',)
AFTER_OFFER = ""
# Context the Stop hook adds waits for the next turn: the model does not answer it before this turn ends, so no
# second Stop comes back to the hook.
STOP_REENTERS = False


def tool_calls(row):
    if row.get("type") != "tool_call":
        return []
    return [(str(row.get("name") or ""), row.get("input"))]


def spoke(row):
    """Whether the row is a message the user typed. The plugin records only the user's own messages this way, not the
    messages it adds itself."""
    return row.get("type") == "user_message"


def stop_output(payload, text):
    return {"hookSpecificOutput": {"hookEventName": payload.get("hook_event_name", "Stop"), "additionalContext": text}}


def offer_how(path):
    if TOOLS:
        return "start one now with the add_row tool"
    return "start one at %s now with %s add <state> TITLE" % (path, _command(path))


def settle_how(path):
    if TOOLS:
        return "Use the set_row tool."
    return "To change a row: %s set <row> <state> [--note TEXT] [--waiting-on WHO] [--question TEXT]." % _command(path)


def ask_how(path):
    if TOOLS:
        return "set_row with waiting_on user and question, or add_row for a new row."
    return "%s set <row> <state> --waiting-on user --question TEXT, or `add` for a new row." % _command(path)


def brief_how(path, parts):
    """The sentence that says how to write each of `parts`, which holds "summary", "status" or both."""
    if TOOLS:
        forms = {"summary": "the set_summary tool (text)", "status": "the set_status tool (doing, progress and next)"}
        return "Use %s. No approval is needed." % " and ".join(forms[p] for p in parts)
    command = _command(path)
    forms = {"summary": "%s summary TEXT" % command,
             "status": "%s status --doing TEXT --progress TEXT --next TEXT" % command}
    return "Write %s with %s." % (" and ".join("the " + p for p in parts), " and ".join(forms[p] for p in parts))


# The Stop hook (nudge-work-plan.py) asks about the brief only after a turn in which a row of the plan changed state:
# what it says stays in the conversation as a message, and one after every turn that did work would fill it.
BRIEF_AFTER_MOVES = True


def status_ahead(path, whole):
    """The sentence that ends the injected block while the brief is on. It asks for the status during the turn, so that
    the call goes out with the turn's other tool calls."""
    if not whole:
        return "If you move a row during this turn, write the status before your final reply."
    if TOOLS:
        return ("If you move a row to another state during this turn, call set_status (doing, progress and next) before "
                "your final reply, in the same reply as your last other tool call if there is one.")
    return ("If you move a row to another state during this turn, write the status before your final reply, and send "
            "it with your last other tool call if there is one. The command is %s status --doing TEXT --progress TEXT "
            "--next TEXT." % _command(path))


"""The reminder when a turn starts working with nothing `doing` (remind-work-plan.py)."""
REMIND_EVENT = "PostToolUse"


def event_calls(payload):
    """The one call a PostToolUse event reports, as a list."""
    return [(payload.get("tool_name"), payload.get("tool_input"))] if payload.get("tool_name") else []


def keeps_plan(tool, given, plan_name):
    return str(tool or "") in PLAN_TOOLS or plan_name in json.dumps(given, ensure_ascii=False, default=str)


def remind_how(path):
    if TOOLS:
        return ("with the set_row tool (state doing), or add_row with state doing if this is new work the user asked for "
                "or something they asked you to look into. ")
    command = _command(path)
    return ("- or, if this is new work the user asked for or something they asked you to look into, add it as `doing`:\n"
            "  %s set <row> doing\n  %s add doing TITLE [--under <row>]\n" % (command, command))


"""Where a conversation is shown, and the folder it keeps its own files in (tell-reply-images.py)."""


def in_panel(payload):
    """The plugin puts in_panel in the event: true when the conversation is in a panel that draws a reply's images."""
    return payload.get("in_panel") is True


def scratch_dir(payload):
    """The conversation's own folder: <OPENCODE_AGENT_PLUS_HOME, else ~/.opencode-agent-plus>/scratch/<session id>/,
    outside the user's workspace and on the machine OpenCode runs on, which is where the extension reads a reply's
    images. None unless the session id has OpenCode's shape, which keeps a name such as ../x from pointing outside the
    folder."""
    session = str(payload.get("session_id") or "").strip()
    if not re.match(r"^%s$" % SESSION_ID, session):
        return None
    return os.path.join(opencode_agent_plus_home(), "scratch", session)


def fixture_scratch_suffix(session_id):
    return "/scratch/" + session_id


def fixture_session_meta(originator, cwd="/work/repo"):
    return ""
