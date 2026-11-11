# Agent Plus

A dependency of Claude Code Plus and Codex Plus: installing either one installs this too. Installed on its own it does nothing.

| Feature | Where |
| --- | --- |
| The work plan (the agent's task list for a conversation, one row per task) of the conversation in front, following the editor tab of either agent | Work plan view, in the Agent Plus sidebar |
| Conversations of this workspace from every installed agent: state, questions in their plans waiting for your answer, rows in progress (`doing`), stopped conversations with unfinished rows; each with its agent's logo | Conversations view, in the panel |
| Answer a plan question, delivered to the window that shows the conversation | Answer view, beside Conversations |
| A conversation's brief on clicking its row, for agents whose extension keeps one: its summary and current status in its own words, when written, whether out of date, what runs now, its questions; else one put together from its plan, marked so. The row's arrow goes to the conversation | Answer view, beside Conversations |
| `N to decide` (questions waiting for you), or `Conversations M` (running ones) when there are none | Status bar |
| Rows in a state this version does not know, and plans in a newer format, marked as such | Work plan and Conversations views |
| VS Code's limit of 32 requests in flight for all webview tabs together, raised on request | VS Code's files |
| The token mode: which features of Claude Code Plus and Codex Plus add to the agent's context ([What it costs in tokens](#what-it-costs-in-tokens)). Hover for what it adds, click to change it; choosing Custom opens the per-feature settings | Status bar |

| Setting | Default | |
| --- | --- | --- |
| `agentPlus.tokenMode` | `all` | Which features may add to the agent's context: `interface`, `essential`, `all` or `custom` ([What it costs in tokens](#what-it-costs-in-tokens)) |
| `agentPlus.workPlanView` | `true` | Show the Work plan view |
| `agentPlus.conversationsView` | `true` | Show the Conversations and Answer views and the Conversations entry in the status bar |
| `agentPlus.webviewRequestLimit` | `ask` | Raise VS Code's request limit: `ask` once per VS Code version, `raise` without asking, or `leave` it |

## What it costs in tokens

| Feature | What it adds to the agent's context | Interface features | Essential features | All features | Custom |
| --- | --- | --- | --- | --- | --- |
| Work plan | The plan's open rows each turn, reminders to keep the plan, and the descriptions of the plan tools, from a plugin Claude Code Plus and Codex Plus install into their agents | Off, plugin unloaded | On | On | Per-feature setting |
| Time-zone note | Your time zone, when it differs from the machine the agent runs on | Off | On | On | Per-feature setting |
| Conversation brief | A request to keep a summary of the conversation and where it stands | Off | Off | On | Per-feature setting |
| Skill suggestions (Codex Plus) | The installed skills that best fit your message, before each turn | Off | Off | On | Per-feature setting |
| Wake-ups (Codex Plus) | A prompt the model scheduled, sent to its conversation when due | Off | Off | On | Per-feature setting |

`agentPlus.tokenMode` controls which features of Claude Code Plus and Codex Plus add text to the agent's context. It defaults to All features. The Interface features mode adds nothing to the agent's context and unloads the work plan plugin from the agent. Choosing another mode puts the plugin back.

Outside Custom, the per-feature settings in Claude Code Plus and Codex Plus have no effect. Modes do not change those settings. Each setting is on by default. Changing one outside Custom shows a notice with a Switch to Custom button.

After a first install, a notice asks once for a mode; closing it keeps All features. If a per-feature setting was changed from its default in an earlier version, upgrading selects Custom so that setting keeps working. The token mode entry in the status bar shows the mode. Hover over it to see what the mode adds to the agent's context, or click it to choose from the four modes.

In a running conversation, a mode change applies from the next message to work plan injection and reminders, the time-zone note, the conversation brief, skill suggestions, and wake-ups. Skill descriptions already in context stay there. Changes to the work plan's tool definitions and to whether the plugin is loaded apply to conversations started after the change. Agent Plus itself adds nothing to a conversation. The Claude Code Plus and Codex Plus READMEs list what each feature adds, the most it can add, and its setting.

## Install

- From the marketplace: install Claude Code Plus or Codex Plus; VS Code installs this with it.
- From `.vsix` files, while this is not on the marketplace: install this one first, then the extension that uses it.

```sh
bash build/pack.sh
code --install-extension build/xnervwang.agent-plus-1.0.0.vsix --force
code --install-extension xnervwang.codex-plus-0.1.0.vsix --force
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
| The request limit is only changed in a VS Code in a standard install location | A portable or ZIP copy, or one in a directory of your own, is not found: the client's application directory is searched in the places each platform puts it, and a remote window cannot ask the client where VS Code was started from. The Agent Plus output, which `Agent Plus: Show Status` opens, then says `no installation found`; no prompt to raise the limit is shown and no file is touched. To raise it anyway, replace `maxActiveHostResourceResponseBodies=32,` with `maxActiveHostResourceResponseBodies=1000000,` in `out/vs/workbench/contrib/webview/browser/pre/service-worker.js` under that copy of VS Code, and quit and reopen it |

## For extension authors

- `docs/protocol.md`: how an extension shows its agent's conversations in Agent Plus.
- `node test/check.js` runs all the tests, with nothing to install first.
