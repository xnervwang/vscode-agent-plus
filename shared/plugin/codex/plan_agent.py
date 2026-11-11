# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/codex/plan_agent.py; sync-shared.js copies it, so edit it there.

"""Codex's side of the work plan hooks: its plugin data directory, how a rollout line is read, its MCP server, and what
it calls things. plan_common.py imports this module, which imports nothing from the plugin.
"""
import json
import os
import re

AGENT = "Codex"
SETTING_PREFIX = "codexPlus"

# Codex gives every plugin a data directory named <plugin>-<marketplace> under $CODEX_HOME/plugins/data, and puts it in
# the hook's environment as PLUGIN_DATA. This is that same name spelled out, for a caller started outside a hook (the
# MCP server, the row command run by hand). It is also the one directory the VS Code extension reads, so falling back to
# it keeps the two halves looking at one place.
PLUGIN_DIR_NAME = "agent-work-plan-codex-extras"
DATA_ENV = ("PLUGIN_DATA", "CLAUDE_PLUGIN_DATA")


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


FALLBACK = os.path.join(codex_home(), "plugins", "data", PLUGIN_DIR_NAME)

EXTRA_DEFAULTS = {
    # The user's model_auto_compact_token_limit from config.toml, which the extension copies here; 0 when none is set.
    # Codex compacts at the lower of it and 90% of the full window, so the marks before a compaction are measured
    # against the lower one too (refresh-work-plan.py).
    "compactTokenLimit": 0,
    # Whether each turn is given the installed skills that best fit the user's message (route-skills.py), found by
    # keywords in the local index. Independent of `enabled`.
    "skillRoute": True,
    # Search by meaning through Amazon Bedrock instead of by keywords. Off unless the user turns it on, and even then
    # used only when Codex's model provider is Bedrock; it sends the user's message to the same account and region Codex
    # already sends the conversation to.
    "skillRouteVector": False,
    # How many skills a turn is given.
    "skillRouteCount": 5,
    # Folders of skills Codex does not read itself, searched as well (missing ones are skipped). ~/.claude/skills is
    # Claude Code's folder of personal skills.
    "skillRouteExtraDirs": ["~/.claude/skills"],
    # Plugins installed for Claude Code but not for Codex whose skills are searched too ("*" for all of them). None by
    # default, since Codex cannot run them.
    "skillRouteClaudePlugins": [],
}
# Settings besides `enabled` and `tellTimeZone` that are off once the extension is gone from every editor.
OFF_WHEN_GONE = ("skillRoute",)

# The field of a hook's input that names the turn: one id from a prompt until the turn ends.
TURN_FIELD = "turn_id"
NO_GROUPING = "it is grouped by date, not by project"

WAKEUP_SUFFIX = ".wakeup"        # the conversation's wake-up (plan-mcp.py set_wakeup; the extension's src/wakeup.js)
WOKE_SUFFIX = ".woke"            # when the extension last queued that wake-up, and whether it is paused

# The model normally changes rows through the MCP server's tools rather than the row command: that command writes
# under CODEX_HOME, which Codex's sandbox does not let a shell command write without an approval. The server's name in
# .mcp.json, and how its tools are named to the model:
MCP_SERVER = "work_plan"
MCP_TOOLS = "the `%s` MCP server's `set_row` and `add_row` tools" % MCP_SERVER


def reply_text(line):
    """The text of an assistant reply on a rollout line, or None when the line is not one. A rollout is one JSON object
    per line, {timestamp, type, payload}; a sub-agent has a thread, and a rollout, of its own."""
    if '"assistant"' not in line and '"agent_message"' not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    payload = row.get("payload") if isinstance(row, dict) else None
    if not isinstance(payload, dict):
        return None
    if row.get("type") == "event_msg" and payload.get("type") == "agent_message":
        return str(payload.get("message") or "")
    if row.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "assistant":
        content = payload.get("content")
        if isinstance(content, list):
            return "".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
    return None


def token_count(line):
    """The `info` of a token_count event on a rollout line, or None. Codex writes one after every model call: its
    last_token_usage.input_tokens is what that call sent, which is the context in use, and model_context_window is the
    window the model has after Codex's own headroom."""
    if '"token_count"' not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    payload = row.get("payload") if isinstance(row, dict) else None
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    info = payload.get("info")
    return info if isinstance(info, dict) else None


def usage_of(line):
    """Input tokens of the model call recorded on a rollout line, or None if the line records none."""
    info = token_count(line)
    last = info.get("last_token_usage") if info else None
    value = last.get("input_tokens") if isinstance(last, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def window_of(line):
    """The context window a token_count event on a rollout line reports, or None."""
    info = token_count(line)
    window = info.get("model_context_window") if info else None
    return window if isinstance(window, int) and not isinstance(window, bool) and window > 0 else None


"""The injected block and the reminders tell the model to change rows through the MCP server's tools, whose arguments
are named this way; the row command is the fallback from a shell."""
WAITING_ON_WORD = "waiting_on"
QUESTION_WORD = "question"
# A sub-agent or a `codex exec` run has a thread of its own.
SESSION_HINT = "If a sub-agent or a codex exec run you started is working on it, set the row to doing."
READ_HINT = "Read it with a tool (cat is enough)"


def row_help(path, command, quoted):
    """The injected block's lines on how to change a row of the plan at `path`; `command` is the row command for it."""
    return ["To change a row, use %s with plan=%s: set_row takes row, state, note, detail, waiting_on and question; "
            "add_row takes state, title, under, note, waiting_on and question. Both read the clock themselves and need no "
            "approval. The same changes from a shell are %s set|add ..., but a shell command cannot write this file "
            "without an approval in the sandbox.%s"
            % (MCP_TOOLS, path, command, " In PowerShell, put & and a space in front of that command line." if quoted else ""),
            "Codex's own update_plan checklist is a different thing: use it for the steps of this turn if you like, and "
            "keep this plan for work that outlives the turn."]


def row_gist(path, command):
    """The few words on changing a row that the injected block gives on a turn when it leaves row_help out."""
    return "set_row or add_row of the `%s` MCP server, with plan=%s" % (MCP_SERVER, path)


def fixture_reply(text):
    """A rollout line holding an assistant reply, for the hooks' self-tests."""
    return json.dumps({"timestamp": "2026-01-01T00:00:00Z", "type": "response_item", "payload": {
        "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}})


def fixture_tool_call():
    """A rollout line holding a turn made of a tool call alone, for the hooks' self-tests."""
    return json.dumps({"timestamp": "2026-01-01T00:00:01Z", "type": "response_item", "payload": {
        "type": "function_call", "name": "exec_command", "arguments": "{}"}})

# A call to one of CHANGING_TOOLS always counts as a change; a call to SHELL_TOOLS counts when its command does
# (changes.py). apply_patch is Codex's file editor; its matcher aliases are Write and Edit, which a hook may also be
# handed. A hook's input names a shell call Bash, and a rollout names it by the tool that ran it.
CHANGING_TOOLS = ("apply_patch", "Write", "Edit")
SHELL_TOOLS = ("Bash", "exec_command", "shell", "local_shell")


"""The user's time zone (tell-time-zone.py).

Codex's own pages already tell the model the user's zone: every turn one of them starts carries a developer message
`<codex_apps_client_time_context><timezone>...</timezone> <current_date>...</current_date> ...>`, from the same Intl
call the zone here comes from. So nothing is said while that message, naming the same zone, is in the transcript since
the last compaction. It is missing from conversations no Codex page started (`codex exec`, the terminal client,
sub-agent threads), from a conversation compacted since, and from one that has grown far past it, which are the cases
left for the hook. Codex's message names neither this machine's zone nor the time, so when the hook does speak it says
more than Codex does.
"""
TOLD_BY = "codex"
CODEX_MARK = "codex_apps_client_time_context"
CODEX_ZONE = re.compile(CODEX_MARK + r">\s*<timezone>([^<\"\\]+)</timezone>")


def agent_told(tail, zone):
    """Whether Codex's own client time message naming `zone` is in the transcript's tail since the last compaction."""
    if tail is None:
        return False
    for line in tail.lines():
        if '"compacted"' in line:
            try:
                row = json.loads(line)
            except Exception:
                row = None
            if isinstance(row, dict) and row.get("type") == "compacted":
                return False
        if CODEX_MARK in line:
            m = CODEX_ZONE.search(line)
            if m and m.group(1) == zone:
                return True
    return False


def fixture_usage(tokens):
    """A rollout line recording a model call that sent `tokens`, for the hooks' self-tests."""
    return json.dumps({"timestamp": "2026-01-01T00:00:00Z", "type": "event_msg", "payload": {
        "type": "token_count", "info": {"last_token_usage": {"input_tokens": tokens}, "model_context_window": 258400}}})


def fixture_agent_told(zone):
    """Codex's own client time message, as Codex 0.164's VS Code page has it recorded: a developer message."""
    return json.dumps({"timestamp": "2026-01-01T00:00:00Z", "type": "response_item", "payload": {
        "type": "message", "role": "developer", "content": [{"type": "input_text", "text":
            "<%s><timezone>%s</timezone> <current_date>2026-10-18</current_date> Use this client time context "
            "for user-facing dates, times, and schedules instead of the execution host's timezone and current "
            "date.</%s>" % (CODEX_MARK, zone, CODEX_MARK)}]}})


def fixture_compacted():
    return json.dumps({"timestamp": "2026-01-01T00:00:02Z", "type": "compacted", "payload": {"message": ""}})


"""Reading a turn back from the rollout, and speaking at its end (nudge-work-plan.py)."""
# Strings a line has to hold to be parsed at all: a tool call, or the user speaking.
MAYBE_CALL = ('"function_call"', '"custom_tool_call"')
MAYBE_USER = ('"UserMessage"', '"user_message"')
NOTE_WORD = "note"
AFTER_OFFER = " Otherwise finish as you were."
# Codex's Stop hook can only keep the turn going with a reason, so the Stop that follows its own output comes back to
# it.
STOP_REENTERS = True


def tool_calls(row):
    """The (name, input) of the tool call recorded on a parsed rollout row, as a list of none or one."""
    payload = row.get("payload") if row.get("type") == "response_item" else None
    if not isinstance(payload, dict):
        return []
    if payload.get("type") == "function_call":
        return [(str(payload.get("name") or ""), payload.get("arguments"))]
    if payload.get("type") == "custom_tool_call":
        return [(str(payload.get("name") or ""), payload.get("input"))]
    return []


def spoke(row):
    """True for a row that is the user speaking.

    Codex records each message the user sent as an item_completed event whose item is a UserMessage. The older
    user_message event is written only for a thread in its legacy history mode: none of 49 rollouts written by Codex
    0.159 and 0.164 held one, against 120 UserMessage items. The response_item rows with role "user" are no use here,
    since Codex also sends its own context to the model that way.
    """
    payload = row.get("payload")
    if row.get("type") != "event_msg" or not isinstance(payload, dict):
        return False
    if payload.get("type") == "item_completed":
        item = payload.get("item")
        return isinstance(item, dict) and item.get("type") == "UserMessage"
    return payload.get("type") == "user_message"


def stop_output(payload, text):
    """Codex's Stop hook cannot add context for later; it can only keep the turn going with a reason, which the model
    reads at once."""
    return {"decision": "block", "reason": text}


def offer_how(path):
    return "start one now with %s, plan=%s" % (MCP_TOOLS, path)


def settle_how(path):
    return "Use %s (plan=%s)." % (MCP_TOOLS, path)


def ask_how(path):
    return "set_row with waiting_on user and question, or add_row for a new row (%s, plan=%s)." % (MCP_TOOLS, path)


def brief_how(path, parts):
    """The sentence that says how to write each of `parts`, which holds "summary", "status" or both."""
    forms = {"summary": "set_summary with text", "status": "set_status with doing, progress and next"}
    return "Use the `%s` MCP server's %s (plan=%s). No approval is needed." % (
        MCP_SERVER, " and ".join(forms[p] for p in parts), path)


"""The reminder when a turn starts working with nothing `doing` (remind-work-plan.py)."""
REMIND_EVENT = "PostToolUse"


def event_calls(payload):
    """The one call a PostToolUse event reports, as a list."""
    return [(payload.get("tool_name"), payload.get("tool_input"))] if payload.get("tool_name") else []


def keeps_plan(tool, given, plan_name):
    """A call that names the plan file, or goes to the plan's own tools, is the plan being kept."""
    return MCP_SERVER in str(tool or "") or plan_name in json.dumps(given, ensure_ascii=False, default=str)


def remind_how(path):
    return ("with %s (plan=%s): set_row with state doing, or add_row with state doing if this is new work the user "
            "asked for or something they asked you to look into. " % (MCP_TOOLS, path))
