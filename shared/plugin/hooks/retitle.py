#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/retitle.py; sync-shared.js copies it, so edit it there.

"""Rename the conversation that runs this command.

  retitle.py [DATA_DIR] <<'EOF'
  New title
  EOF

The new title is standard input; the conversation is the one the agent names in plan_agent.SELF_ENV, so a
conversation can rename only itself. The VS Code extension hosting it does the renaming and answers
(plan_common.request_retitle). Prints what came of it, and exits 0 when the title was changed and 1 when it was not.
"""
import os
import sys

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import AGENT, SELF_ENV, data_dir, request_retitle  # noqa: E402

SAID = {
    "done": "Renamed: the conversation is now titled %(title)r.",
    "refused": "Not renamed: %(reason)s.",
    "failed": "Not renamed: %(reason)s.",
    "untaken": "Not renamed: %(reason)s. The title changes only through a VS Code window that shows %(agent)s conversations.",
    "unclear": "Unclear whether it was renamed: %(reason)s.",
}


def main():
    if not SELF_ENV:
        print("Not renamed: %s does not say which conversation runs a command; use the set_title tool instead." % AGENT)
        return 1
    session = os.environ.get(SELF_ENV, "")
    if not session:
        print("Not renamed: %s does not say which conversation runs this command (%s is not set)." % (AGENT, SELF_ENV))
        return 1
    title = sys.stdin.buffer.read().decode("utf-8", "replace").strip()
    got = request_retitle(session, title, directory=data_dir(), via="command")
    print(SAID.get(got["outcome"], SAID["failed"]) % dict(got, agent=AGENT))
    return 0 if got["outcome"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
