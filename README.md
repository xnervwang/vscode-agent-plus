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
code --install-extension build/xnervwang.agent-work-plan-1.0.0.vsix
code --install-extension xnervwang.codex-extras-0.1.0.vsix
```

- In a Remote SSH window, install both on the remote.
- In Restricted Mode the views are read only: no answer is sent and nothing is written. An untrusted window also cannot tell whether anything uses this extension, since VS Code disables an extension whose own dependency is disabled, so it draws the views and says nothing.
- `Agent Work Plan: Show Status` lists the extensions using it and the registered sources.

## For extension authors

- `docs/protocol.md`: registering a source, the interface, plan files, answers, versions.
- `node test/check.js`: the whole suite, no dependencies.
