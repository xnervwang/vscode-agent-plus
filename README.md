# Agent Plus

A dependency of Claude Code Plus and Codex Plus: installing either one installs this too. Installed on its own it does nothing.

| Feature | Where |
| --- | --- |
| The work plan (the agent's task list for a conversation, one row per task) of the conversation in front, following the editor tab of either agent. A row with a question for you has an orange question mark, and clicking the row opens the question in the Answer view, beside the Conversations view. The pen at the end of a row, shown when the agent's extension supports it, brings the conversation to the front with `About row N (title): `, filled in with the row's number and title, in its message box, in VS Code's display language, for you to finish and send | Work plan view, in the Agent Plus sidebar |
| Conversations of this workspace from every installed agent, the one in front first: state, questions in their plans waiting for your answer, rows in progress (`doing`), stopped conversations with unfinished rows; each with its agent's logo when more than one agent is installed. A green dot means a turn is running, a green ring that only background work runs, a red dot that it waits for you; a stopped conversation has no dot. An envelope at the end of a row means a reply you have not read | Conversations view, in the panel |
| Answer a plan question, delivered to the window that shows the conversation | Answer view, beside Conversations |
| A conversation's brief on clicking its row, for agents whose extension keeps one: its summary and current status in its own words, when written, whether out of date, what runs now; else one put together from its plan, marked so. The row's arrow goes to the conversation | Answer view, beside Conversations |
| `N conversations need you` on a yellow background, or `Conversations M` (running ones) when none needs you. `N` counts, each once, running conversations whose plan has a question waiting for you (even when they are in front) and conversations in any VS Code window waiting for you to approve something or answer (except the conversation shown in front in the focused window); hovering over the entry lists the two kinds under separate headings. A conversation that stopped with a reply you have not read is not counted, as it gets a notification instead. With `agentPlus.conversationsView` off, the entry appears only while a conversation waits for your approval or answer, and a click lists those conversations to open one. A conversation counts as running while its agent's extension says so: Codex Plus while a turn runs, while something it started is still running after its turn, while a tab in this window shows it, or for 15 minutes after it was last active; Claude Code Plus while a Claude Code process has it open | Status bar |
| Conversations of this workspace from every installed agent in one list: each row has a state dot (green for a running turn, a green ring for background work only, blue for a pending approval, red for a plan question that needs your answer). A stripe at the start of a row marks a conversation open in this window, open elsewhere (the row is dimmed), or recently closed in this window (a light blue stripe). You can organize conversations with groups, pins and title colours. You can search the list or filter by agent. The sidebar has Recently closed and Archived sections and an Account & usage section with a block for each agent. Conversations inactive for 14 days are archived and archived ones deleted after 90 days (the `agentPlus.sessions` settings below); open, running, unread, grouped and pinned ones are not archived. Clicking a row open in another VS Code window brings that window to the front. Ctrl+Shift+T (Cmd+Shift+T) reopens the most recently closed conversation. In Restricted Mode the list only opens conversations | Conversations sidebar |
| Rows in a state this version of Agent Plus does not know, and plans in a newer format, marked as such | Work plan and Conversations views |
| A notification when a conversation in any VS Code window on this machine (see Known limits) starts waiting for you or remains stopped for 5 seconds after leaving a reply you have not read. When the agent reports what it needs, the notification names the tool it wants to run or says it has a question for you or a plan for you to review. Only the window that has the focus shows notifications, and it skips conversations already open there: you can see the conversation in front, and the tab dot indicates the status of conversations in background tabs or in the side bar, with the status bar's `N conversations need you` counting those waiting for you. The one in front is not counted either. Notifications that arrive while no window has the focus appear once, when a window gets the focus again. Each conversation gets a notification of its own. It has an Open and a Dismiss button; Open brings its conversation, and the window that shows it, to the front | Notification |
| VS Code's limit of 32 requests in flight for all webview tabs together, raised on request | VS Code's files |
| The token mode: which features of Claude Code Plus and Codex Plus add to the agent's context ([What it costs in tokens](#what-it-costs-in-tokens)). Hover for what it adds, click to change it; choosing Custom opens the per-feature settings | Status bar |

| Setting | Default | |
| --- | --- | --- |
| `agentPlus.tokenMode` | `all` | Which features may add to the agent's context: `interface`, `essential`, `all` or `custom` ([What it costs in tokens](#what-it-costs-in-tokens)) |
| `agentPlus.workPlanView` | `true` | Show the Work plan view |
| `agentPlus.conversationsView` | `true` | Show the Conversations and Answer views and keep the Conversations entry visible in the status bar. When this setting is off, both views are hidden. The entry appears only when a conversation needs your approval or answer. It shows `N conversations need you` and counts only those conversations. Click it to choose one to open. |
| `agentPlus.notifications.enabled` | `true` | Show those notifications and the count in the status bar. The two settings below turn off only notifications: a conversation waiting for you is still counted |
| `agentPlus.notifications.finished` | `true` | Notify about conversations that stopped with a reply you have not read (an envelope) |
| `agentPlus.notifications.waiting` | `true` | Notify about conversations waiting for your permission or answer (a red dot) |
| `agentPlus.webviewRequestLimit` | `ask` | Raise VS Code's request limit: `ask` once per VS Code version, `raise` without asking, or `leave` it |
| `agentPlus.sessions.archiveAfterDays` | `14` | Archive a conversation in the Conversations sidebar once it has been inactive for this many days; 0 turns this off. Conversations that are open, running, waiting for your approval or answer, unread, pinned or in a group are never archived |
| `agentPlus.sessions.deleteArchived` | `true` | Delete archived conversations from disk after the number of days in `agentPlus.sessions.deleteAfterDays`. Pinned, open and running conversations are never deleted |
| `agentPlus.sessions.deleteAfterDays` | `90` | Days until an archived conversation is deleted while `agentPlus.sessions.deleteArchived` is on, counted from when it was archived or from its last message, whichever is later |
| `agentPlus.sessions.recentlyClosed` | `10` | The number of conversations closed in this window that Recently closed shows; 0 hides the section |
| `agentPlus.sessions.hideBackground` | `true` | Hide background runs, sub-agents and empty conversations in the Conversations sidebar |

## What it costs in tokens

| Feature | What it adds to the agent's context | Interface features | Essential features | All features | Custom |
| --- | --- | --- | --- | --- | --- |
| Work plan | The plan's open rows each turn, reminders to keep the plan, and the descriptions of the plan tools, from a plugin Claude Code Plus and Codex Plus install into their agents | Off, plugin unloaded | On | On | `claudeCodePlus.workPlan`, `codexPlus.workPlan`, `opencodeAgentPlus.workPlan` |
| Time-zone note | Your time zone, when it differs from the machine the agent runs on | Off | On | On | `claudeCodePlus.tellClaudeYourTimeZone`, `codexPlus.tellCodexYourTimeZone`, `opencodeAgentPlus.tellOpenCodeYourTimeZone` |
| Conversation brief | A request to keep a summary of the conversation and where it stands | Off | Off | On | `claudeCodePlus.conversationBrief`, `codexPlus.conversationBrief`, `opencodeAgentPlus.conversationBrief` |
| Wake-ups (Codex Plus) | A prompt the model scheduled, sent to its conversation when due | Off | Off | On | `codexPlus.wakeUps` |
| Detached-command notices | A notice to the conversation that left a command running detached, once that command is no longer running | Off | Off | On | `claudeCodePlus.detachedEndNotices`, `codexPlus.detachedEndNotices` |

`agentPlus.tokenMode` controls which features of Claude Code Plus and Codex Plus add text to the agent's context. It defaults to All features. The Interface features mode adds nothing to the agent's context and unloads the work plan plugin from the agent. Choosing another mode puts the plugin back.

Outside Custom, the per-feature settings in Claude Code Plus and Codex Plus have no effect. Modes do not change those settings. Each setting is on by default. Changing one outside Custom shows a notice with a Switch to Custom button.

After a first install, a notice asks once for a mode; closing it keeps All features. If a per-feature setting was changed from its default in an earlier version, upgrading selects Custom so that setting keeps working. The token mode entry in the status bar shows the mode. Hover over it to see what the mode adds to the agent's context, or click it to choose from the four modes.

In a running conversation, a mode change applies from the next message to the plan rows added to each turn and the plan reminders, the time-zone note, the conversation brief, wake-ups, and detached-command notices. Changes to the work plan's tool definitions and to whether the plugin is loaded apply to conversations started after the change. Agent Plus itself adds nothing to a conversation. The Claude Code Plus and Codex Plus READMEs list what each feature adds, the most it can add, and its setting.

## Install

- From the marketplace: install Claude Code Plus or Codex Plus; VS Code installs this with it.
- From `.vsix` files: install this one first, then the extension that uses it.

```sh
bash build/pack.sh
code --install-extension build/xnervwang.agent-plus-<version>.vsix --force
code --install-extension xnervwang.codex-plus-<version>.vsix --force
```

- `--force` installs a `.vsix` whose version number is already installed, which a rebuilt one is.
- A rebuilt `.vsix` needs VS Code quit and opened again, not only the window reloaded, when it changes a view's `when` clause.

- In a Remote SSH window, install Agent Plus and the extension that uses it on the remote.
- In Restricted Mode the views are read only: no answer is sent and nothing is written. An untrusted window also cannot see the extension that uses this one, since VS Code disables an extension when one of its dependencies is disabled, so Agent Plus hides the views and says nothing until the workspace is trusted.
- `Agent Plus: Show Status` lists the extensions using it and the agents they registered.

## Uninstall

- If the request limit was raised, run `Agent Plus: Put Back VS Code's Request Limit` before uninstalling Agent Plus.
- The command stays in the command palette after the extensions that use Agent Plus are gone.
- Once nothing uses Agent Plus, a notice says it can be uninstalled. If the limit is still raised, the notice offers to put the limit back first.

Uninstalling cannot put the limit back. The uninstall hook (`vscode:uninstall`) runs as plain Node on the machine the extension is installed on, which in a remote window is the remote, while the limit is in VS Code's `service-worker.js` on the client, the machine the window runs on. `deactivate`, the extension's shutdown function, runs after the extension host (the process extensions run in) has dropped its connection to the window, so it cannot reach the client's files either.

## Known limits

| Limit | Detail |
| --- | --- |
| The envelope needs file decoration badges | It is a badge like the Explorer's, so it is hidden while `explorer.decorations.badges` is off |
| Notifications reach the windows of one machine | The windows share them through a folder in your home folder, so a window connected to another machine, over Remote-SSH say, hears from the windows on that machine only. There is no system notification while no VS Code window has the focus. Open uses VS Code's command line, which cannot reach a VS Code instance started with its own user data folder (`--user-data-dir`) |
| The request limit is only changed in a VS Code in a standard install location | A portable or ZIP copy, or one in a directory of your own, is not found: the client's application directory is searched in the places each platform puts it, and a remote window cannot ask the client where VS Code was started from. The Agent Plus output, which `Agent Plus: Show Status` opens, then says `no installation found`; no prompt to raise the limit is shown and no file is touched. To raise it anyway, replace `maxActiveHostResourceResponseBodies=32,` with `maxActiveHostResourceResponseBodies=1000000,` in `out/vs/workbench/contrib/webview/browser/pre/service-worker.js` under that copy of VS Code, and quit and reopen it |

## For extension authors

- `docs/protocol.md`: how an extension shows its agent's conversations in Agent Plus.
- `node test/check.js` runs all the tests, with nothing to install first.
- `node test/vscode/run.js <the Agent Plus .vsix> --local` runs the extension in real VS Code windows with a stand-in agent (`--local` lets it run outside CI); `--look` also saves a screenshot of each test step to review. `.github/workflows/vscode.yml` runs `test/vscode/run.js` on Linux, macOS and Windows.
- `bash build/pre-push.sh` runs `node test/check.js`, builds the package and installs it in a VS Code of its own to see that Agent Plus starts; `git config core.hooksPath .githooks` makes every `git push` from a clone run `build/pre-push.sh` first.
- To run selected steps locally, use `AGENT_PLUS_UI_STEPS='^(alone|first-start)$' node test/vscode/run.js <the Agent Plus .vsix> --local`; this example runs the window test's first two steps. The test runs the steps in `test/vscode/ui.js` whose names match the regular expression, plus any steps they require directly or indirectly through `needs()`. When a step fails, the test run saves a screenshot, and the window's HTML and text in `state/` in the folder given to `--out`.
- On GitHub, open the `vscode` workflow and use its "Run workflow" button. Choose one system or `all` (all three) in `os`, then enter a regular expression in `steps` if you want to limit the run; an empty `steps` field runs every step.
