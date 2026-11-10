# Agent Plus

A dependency of Claude Code Plus and Codex Plus: installing either one installs this too. Installed on its own it does nothing.

| Feature | Where |
| --- | --- |
| The work plan (the agent's task list for a conversation, one row per task) of the conversation in front, following the editor tab of either agent | Work plan view, in the Agent Plus sidebar |
| Conversations of this workspace from every installed agent: state, questions waiting in their plans, rows in progress (`doing`), stopped ones with unfinished rows; each with its agent's logo | Conversations view, in the panel |
| Answer a plan question, delivered to the window that shows the conversation | Answer view, beside Conversations |
| `N to decide` (questions waiting for you), or `Conversations M` (running ones) when there are none | Status bar |
| Rows in a state this version does not know, and plans in a newer format, marked as such | Work plan and Conversations views |
| VS Code's limit of 32 requests in flight for all webview tabs together, raised on request | VS Code's files |

| Setting | Default | |
| --- | --- | --- |
| `agentPlus.workPlanView` | `true` | Show the Work plan view |
| `agentPlus.conversationsView` | `true` | Show the Conversations and Answer views and the status bar entry |
| `agentPlus.webviewRequestLimit` | `ask` | Raise VS Code's request limit: `ask` once per VS Code version, `raise` without asking, or `leave` it |

## Install

- From the marketplace: install Claude Code Plus or Codex Plus; VS Code installs this with it.
- From `.vsix` files, while this is not on the marketplace: install this one first, then the extension that uses it.

```sh
bash build/pack.sh
code --install-extension build/xnervwang.agent-plus-1.0.0.vsix --force
code --install-extension xnervwang.codex-plus-0.1.0.vsix --force
```

- `--force` installs a `.vsix` whose version number is already installed, which a rebuilt one is.
- A new build needs VS Code quit and opened again, not only the window reloaded, when it changes a view's `when` clause.

- In a Remote SSH window, install Agent Plus and the extension that uses it on the remote.
- In Restricted Mode the views are read only: no answer is sent and nothing is written. An untrusted window also cannot see the extension that uses this one, since VS Code disables an extension whose own dependency is disabled, so Agent Plus hides the views and says nothing until the workspace is trusted.
- `Agent Plus: Show Status` lists the extensions using it and the agents they registered.

## Uninstall

- If the request limit was raised, run `Agent Plus: Put Back VS Code's Request Limit` before uninstalling.
- The command stays in the command palette after the extensions that use Agent Plus are gone.
- Once nothing uses Agent Plus, it shows a notice that it can be uninstalled. If the limit is still raised, it offers to put it back first.

Uninstalling cannot put the limit back. The uninstall hook (`vscode:uninstall`) runs as plain Node on the machine the extension is installed on, which in a remote window is the remote, while the limit is in a file on the client, the machine the window runs on. `deactivate`, the extension's shutdown function, runs after the extension host has dropped its connection to the window, so it cannot reach the client's files either.

## Known limits

| Limit | Detail |
| --- | --- |
| The request limit is only changed in a VS Code in a standard install location | A portable or ZIP copy, or one in a directory of your own, is not found: the client's application directory is searched in the places each platform puts it, and a remote window cannot ask the client where VS Code was started from. `Agent Plus: Show Status` then logs `no installation found`, nothing is asked and no file is touched. To raise it anyway, replace `maxActiveHostResourceResponseBodies=32,` with `maxActiveHostResourceResponseBodies=1000000,` in `out/vs/workbench/contrib/webview/browser/pre/service-worker.js` under that copy of VS Code, and quit and reopen it |

## For extension authors

- `docs/protocol.md`: how an extension shows its agent's conversations in Agent Plus.
- `node test/check.js` runs all the tests.
