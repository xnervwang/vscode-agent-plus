---
name: retitle
description: Load when the user asks to rename this conversation or its title no longer describes the work.
version: 1.0.0
tags: [conversation, title, agent-plus]
---
<!-- Source: vscode-agent-plus shared/plugin/skills/retitle/SKILL.md; sync-shared.js copies it, so edit it there. -->

# Rename this conversation

The title appears in the editor's tab and in the Agent Plus conversation list. Rename only the conversation making the request.

## When to rename

- The user asks for a rename in this turn.
- The title is still a placeholder such as "New conversation" or the first words of the first message, and the work is now clear.
- The conversation has moved to different work, and the title describes the old work.

The agent or its extension may set or regenerate the title. If something changes a title you set, rename it again only when one of these reasons applies.

## When not to rename

Keep a title the user set by hand or told this conversation to use, unless they now ask for a new one. Do not rename more than once for the same reason.

Do not rename to report progress or state. Skip words such as "done", "waiting", or "blocked", and dates or percentages that will go stale. Do not rename to add a crown, an envelope, or another mark. The extensions draw those marks and strip them from requested titles.

## What makes a good title

Name the work in the language of the conversation. Use words the user would look for in a list. Fewer than 40 characters read best in a narrow list; the extension cuts the title at 80 characters. Omit session IDs. Include a file path only if the file is the subject.

## How to rename

{{how}}

The tool or command writes a request. The VS Code window hosting this conversation checks that the request came from the conversation itself, cleans the title, uses the agent's own rename method, and answers within about 15 seconds, at most about 25.

## What the answer means

- Renamed: the reply gives the title as set. It may be shorter or have marks removed. If the user asked for the rename, tell them the new title in one short sentence. Otherwise, stop.
- Not renamed: the reply gives the reason. If you can fix the cause, such as an empty title, fix it and try once more. If you cannot fix it or the retry fails, tell the user and stop. The window may have been unable to confirm that this conversation sent the request.
- Not renamed because no window took the request: no VS Code window hosts this conversation. The title did not change.
- Unclear: a window took the request but did not answer in time. The result is unknown.

When no window took the request, or the result is unclear, stop without retrying. Report the result if the user asked for the rename.
