#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/tell-reply-images.py; sync-shared.js copies it, so edit it there.

"""Tell the model that the panel shows images in its replies, and how to link one.

A model does not know the panel draws an image a reply links to, so without this it never draws a chart for the user.
It is told when a conversation starts, and again after a compaction, since the summary drops it: where to save the file
(the conversation's own folder, spelled out, since a model cannot work out the folder name), that the link takes an
absolute path, and that an image from the web is to be downloaded into that folder first. The panels show an image
link to a web address only as a plain link and never fetch it, so that an address a page slipped into a reply cannot
carry anything out.

It is said only while all of this holds, so that a model is never told to write links that nothing will draw:
  - the extension wrote `replyImages` on in config.json, which it does only while its option for images in replies is
    on and its panel really draws them (the panel patch is in place, or the agent's build is one the extension has
    checked). The same option decides whether the panel draws them;
  - the conversation is one the VS Code panel shows (plan_agent.in_panel), not `claude -p`, `codex exec` or a terminal.
Otherwise nothing is said, and the option off costs no tokens. The one exception is a conversation told the note since
its last compaction: its next message gets a single short sentence saying images are no longer shown.

What was said is kept per conversation beside its plan (IMAGES_TOLD_SUFFIX), swept with it.
"""
import json
import os
import sys

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (IMAGES_TOLD_SUFFIX, fixture_compacted, fixture_reply, fixture_session_meta, in_panel,
                       latest_reply_matches, open_tail, plan_file, read_payload, scratch_dir, settings, side_file,
                       write_quietly)

# Said once, and only to a conversation that was told the note and has not been compacted since: without it, that
# model goes on linking images nothing draws. Kept short because it is the one thing said while the option is off.
NO_LONGER = "Images in replies are no longer shown; give the file's path instead."


def folder_for(payload):
    """The conversation's folder with forward slashes, which the panels read on Windows too; '' without one."""
    found = scratch_dir(payload)
    return found.replace("\\", "/") if found else ""


def note(folder):
    return ("This panel shows images in your replies. To show a chart, diagram or screenshot, save it as a PNG or SVG "
            "file with an ASCII name in %s (create the folder if needed) and write ![what it shows](<the file's "
            "absolute path>); do not use relative paths or data: URLs. For an image from the web, download it there "
            "first: an image link to a web address shows only as a link." % folder)


def told_file(payload, directory=None):
    plan = plan_file(payload, directory)
    return side_file(plan, IMAGES_TOLD_SUFFIX) if plan else None


def read_told(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def respond(payload, directory=None):
    """What to say for this event, recording it; empty when nothing is to be said."""
    limits = settings(directory)
    event = payload.get("hook_event_name", "UserPromptSubmit")
    folder = folder_for(payload)
    holds = bool(limits["replyImages"]) and bool(folder) and in_panel(payload)
    path = told_file(payload, directory)
    told = read_told(path) if path else None
    was_told = bool(told and told.get("told"))
    if not holds:
        if not was_told:
            return ""
        if path:
            write_quietly(path, json.dumps({"told": False}))
        # After a compaction the earlier note is summarised away with the rest, so there is nothing to take back.
        return "" if event == "SessionStart" else NO_LONGER
    if event == "SessionStart":
        # See tell-time-zone.py: a conversation relaying another model word for word is left alone after a compaction.
        if latest_reply_matches(open_tail(payload.get("transcript_path")), limits["quietWhenReplyMatches"]):
            return ""
    elif was_told and told.get("folder") == folder:
        return ""
    if path:
        write_quietly(path, json.dumps({"told": True, "folder": folder}))
    return note(folder)


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    text = respond(payload)
    if text:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": text}}))
    return 0


def selftest():
    import shutil
    import tempfile

    failures = []

    def check(label, cond):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            failures.append(label)

    tmp = tempfile.mkdtemp()
    saved = {k: os.environ.get(k) for k in ("CLAUDE_CODE_ENTRYPOINT", "CODEX_HOME", "CLAUDE_CONFIG_DIR")}
    try:
        os.environ["CODEX_HOME"] = os.path.join(tmp, "codex-home")
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(tmp, "claude-home")
        project = os.path.join(tmp, "projects", "-work-repo")
        os.makedirs(project)
        transcript = os.path.join(project, "5e000000-0000-0000-0000-000000000000.jsonl")

        def shown_in(where):
            """Puts the conversation in the panel or out of it, as this agent tells the two apart."""
            os.environ["CLAUDE_CODE_ENTRYPOINT"] = "claude-vscode" if where == "panel" else "cli"
            meta = fixture_session_meta("codex_vscode" if where == "panel" else "codex_exec")
            with open(transcript, "w", encoding="utf-8") as fh:
                fh.write((meta + "\n" if meta else "") + fixture_reply("Done.") + "\n")

        def setting(on):
            with open(os.path.join(tmp, "config.json"), "w", encoding="utf-8") as fh:
                json.dump({"replyImages": on}, fh)

        message = {"hook_event_name": "UserPromptSubmit", "session_id": "5e000000-0000-0000-0000-000000000000",
                   "transcript_path": transcript, "cwd": "/work/repo"}
        compacted = dict(message, hook_event_name="SessionStart", source="compact")
        shown_in("panel")
        check("with no settings written nothing is said", respond(message, tmp) == "")
        setting(True)
        said = respond(message, tmp)
        folder = folder_for(message)
        check("with the setting on, in the panel, the first message is told", said.startswith("This panel shows images"))
        check("  naming the conversation's own folder", folder and folder in said and folder.endswith(
            "/scratch/-work-repo/5e000000-0000-0000-0000-000000000000"))
        check("  and asking for an absolute path, and for an image from the web to be downloaded first",
              "absolute path" in said and "download it there first" in said)
        check("the next message is not told again", respond(message, tmp) == "")
        check("a compaction tells it again", respond(compacted, tmp).startswith("This panel shows images"))
        check("and the message after it is not told a third time", respond(message, tmp) == "")
        setting(False)
        check("once the setting is off, the next message is told images are no longer shown",
              respond(message, tmp) == NO_LONGER)
        check("and only once", respond(message, tmp) == "")
        setting(True)
        check("turned back on, it is told again", respond(message, tmp).startswith("This panel shows images"))
        shown_in("elsewhere")
        check("a conversation the panel does not show is told images are no longer shown", respond(message, tmp) == NO_LONGER)
        fresh = dict(message, session_id="5e000000-0000-0000-0000-000000000001")
        check("and a new one outside the panel is told nothing", respond(fresh, tmp) == "")
        shown_in("panel")
        check("a new one in the panel is told", respond(fresh, tmp) != "")
        respond(dict(message, session_id="5e000000-0000-0000-0000-000000000002"), tmp)
        setting(False)
        check("after a compaction with the setting off there is nothing to take back",
              respond(dict(compacted, session_id="5e000000-0000-0000-0000-000000000002"), tmp) == "")
        with open(os.path.join(tmp, "config.json"), "w", encoding="utf-8") as fh:
            json.dump({"replyImages": True, "extensionMarkers": [os.path.join(tmp, "gone")]}, fh)
        check("with the extension uninstalled from every editor nothing is said",
              respond(dict(message, session_id="5e000000-0000-0000-0000-000000000003"), tmp) == "")
        setting(True)
        check("a message with no session id names no folder and says nothing",
              respond(dict(message, session_id=""), tmp) == "")
        with open(os.path.join(tmp, "config.json"), "w", encoding="utf-8") as fh:
            json.dump({"replyImages": True, "quietWhenReplyMatches": "^Done"}, fh)
        check("a compaction in a conversation that relays another model says nothing",
              respond(dict(compacted, session_id="5e000000-0000-0000-0000-000000000004"), tmp) == "")
        with open(transcript, "a", encoding="utf-8") as fh:
            fh.write(fixture_compacted() + "\n")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("%d checks failed" % len(failures))
        return 1
    print("all checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if sys.argv[1:2] == ["--selftest"] else main())
