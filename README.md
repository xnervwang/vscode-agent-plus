# Agent Work Plan

A dependency of Work Plan for Claude Code and Codex Extras: installing either one installs this too. Installed on its own it does nothing.

| Feature | Where |
| --- | --- |
| The work plan of the conversation in front, following the editor tab of either agent | Work plan view, in the Agent Work Plan sidebar |
| Conversations of this workspace from every installed agent: state, plan questions, `doing` rows, stopped ones with open rows; each row with its agent's logo | Conversations view, in the panel |
| Answer a plan question, delivered to the window that shows the conversation | Answer view, beside Conversations |
| `N to decide` / `Conversations M` | Status bar |
| Rows in a state this version does not know, and plans in a newer format, marked as such | Work plan and Conversations views |
| VS Code's webview request limit raised from 32, on request | VS Code's files |

| Setting | Default | |
| --- | --- | --- |
| `agentWorkPlan.workPlanView` | `true` | Show the Work plan view |
| `agentWorkPlan.conversationsView` | `true` | Show the Conversations and Answer views and the status bar entry |
| `agentWorkPlan.webviewRequestLimit` | `ask` | `ask`, `raise` or `leave` |

## Install

- From the marketplace: install Work Plan for Claude Code or Codex Extras; VS Code installs this with it.
- From `.vsix` files, while this is not on the marketplace: install this one first, then the extension that uses it.

```sh
bash build/pack.sh
code --install-extension build/xnervwang.agent-work-plan-1.0.0.vsix --force
code --install-extension xnervwang.codex-extras-0.1.0.vsix --force
```

- `--force` installs a `.vsix` whose version number is already installed, which a rebuilt one is.
- A new build needs VS Code quit and opened again, not only the window reloaded, when it changes what a view's `when` reads.

- In a Remote SSH window, install both on the remote.
- In Restricted Mode the views are read only: no answer is sent and nothing is written. An untrusted window also cannot see the extension that uses this one, since VS Code disables an extension whose own dependency is disabled, so it hides the views and says nothing until the workspace is trusted.
- `Agent Work Plan: Show Status` lists the extensions using it and the registered sources.

## Known limits

| Limit | Detail |
| --- | --- |
| The request limit is only changed in a VS Code installed where VS Code installs itself | A portable or ZIP copy, or one in a directory of your own, is not found: the client's application directory is searched in the places each platform puts it, and a remote window cannot ask the client where it was started from. `Agent Work Plan: Show Status` then logs `no installation found`, nothing is asked and no file is touched. To raise it anyway, replace `maxActiveHostResourceResponseBodies=32,` with `maxActiveHostResourceResponseBodies=1000000,` in `out/vs/workbench/contrib/webview/browser/pre/service-worker.js` under that copy of VS Code, and quit and reopen it |

## For extension authors

- `docs/protocol.md`: registering a source, the interface, plan files, answers, versions.
- `node test/check.js`: the whole suite, no dependencies.
