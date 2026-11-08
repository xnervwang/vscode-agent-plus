# Agent Work Plan protocol, major 1

How an extension shows its agent's conversations in Agent Work Plan (`xnervwang.agent-work-plan`). Based on the work plan host protocol of Claude Code Extras (`docs/work-plan-host.md` at vscode-claude-code-extras `d2efd51`), renamed and renumbered.

## Roles

| Part | Who | Does |
| --- | --- | --- |
| Core | Agent Work Plan | Work plan view, Conversations view, Answer view, status bar entry, reading plan files, answers across windows, VS Code's webview request limit |
| Source | Each feature extension (Claude Code Extras, Codex Extras) | One agent's conversations, plans, tabs, focus, answer typing |

## Setting up a feature extension

| Field in its `package.json` | Value | Why |
| --- | --- | --- |
| `extensionDependencies` | includes `xnervwang.agent-work-plan` | VS Code installs and activates the core first |
| `agentWorkPlan.protocol` | the protocol major its source implements, `1` | The core reads it from the manifest before the extension activates, to say which extension to update |
| `extensionKind` | `["workspace"]` | `exports` cannot cross extension hosts; the core is `workspace` too |
| `capabilities.untrustedWorkspaces` | `{ "supported": "limited", ... }` | The core runs limited in Restricted Mode; an extension disabled there would leave it looking alone |

- Get the interface: `vscode.extensions.getExtension('xnervwang.agent-work-plan').exports.agentWorkPlan`. The core is active by then; `await ext.activate()` is harmless.
- Call `registerSource(source)` once. Show views of your own only after `accepted` is true, under a context key you set then.
- A view the core does not draw (such as a session list) can go in the core's activity bar container, id `agentWorkPlan`.

## Ids the core owns

| Kind | Id |
| --- | --- |
| Activity bar container | `agentWorkPlan` |
| Panel container | `agentWorkPlanPanel` |
| Views | `agentWorkPlan.workPlan`, `agentWorkPlan.conversations`, `agentWorkPlan.answer` |
| Context key | `agentWorkPlan.alone`: set to true only once the core finds nothing installed that depends on it and no source registered. The views, the status bar entry and the commands are hidden by `!agentWorkPlan.alone`, so an unset key shows them: the key does not exist until the core has activated, and a window's panel is put back before that |
| Commands | `agentWorkPlan.*` |
| Settings | `agentWorkPlan.workPlanView`, `agentWorkPlan.conversationsView`, `agentWorkPlan.webviewRequestLimit` |

## The interface

| Member | Meaning |
| --- | --- |
| `family` | `'agent-work-plan'` |
| `version` | The core's marketplace version |
| `protocol` | The newest protocol major the core implements; also the first number of `version` |
| `accepts` | The source protocol majors the core accepts |
| `features` | Optional core capabilities by name; none in major 1 |
| `registerSource(source)` | Registers a source; never throws; returns a frozen result |

### Result of `registerSource`

| Field | Meaning |
| --- | --- |
| `accepted` | `true` when the source is registered |
| `code` | `''` when accepted, else one of the codes below |
| `reason` | A sentence saying why it was refused |
| `registration` | A `vscode.Disposable` when accepted, else `null`. Disposing removes the source and its conversations |

| `code` | When |
| --- | --- |
| `shape` | Not an object, or `protocol` is not a positive integer |
| `core-too-old` | `protocol` is above every major in `accepts` |
| `source-too-old` | `protocol` is below every major in `accepts` |
| `id` | `id` is not a usable id (see limits) |
| `duplicate` | A source with that id is registered |
| `closing` | The window is closing |
| `failed` | The core could not start, or attaching the source failed |

- On `core-too-old` and `source-too-old` the core tells the user which extension to update. The source says nothing more.

## Source members

Only `protocol` and `id` are required. A missing member, or one that throws when read or called, counts as absent.

| Member | Meaning |
| --- | --- |
| `protocol` | `1` |
| `features` | Optional capability names the source implements; none in major 1 |
| `id` | Source id, such as `'codex'` or `'claude-code'` |
| `label` | Shown in tooltips and in the work plan view's description |
| `extensionId` | The extension that registered it, such as `'xnervwang.codex-extras'`; used for update notices |
| `logo` | `{ light, dark }` SVG `vscode.Uri` values, read from the agent's own extension; drawn with a state dot when more than one source is registered |
| `planPath(sessionId)` | Absolute path of the conversation's plan file, or `null` |
| `planDir()` | Folder of the plan files; the core watches it, with the folder itself as the watcher's base and `*.json` as the pattern, and never writes or deletes in it. A folder that does not exist yet is watched once it appears |
| `sessionForTab(tab)` | A session id for a tab showing that conversation; `''` for this source's tab with no conversation yet; anything else for a tab not its own. Asked again for the same tab object once its label changes, and on every tab event while the last answer was `''`: a tab keeps one object for its whole life, so a new conversation answers `''` and then an id without ever becoming a different tab |
| `onDidFocus` | `vscode.Event<{ sessionId }>` when a conversation comes to front outside an editor tab |
| `isFocused(sessionId)` | Whether that conversation is still in front; the core asks before taking an `onDidFocus` report |
| `listConversations()` | `Promise<Conversation[]>`; the array may carry a string `problem`, shown above the source's rows |
| `onDidChangeConversations` | `vscode.Event<void>` |
| `reveal(sessionId, row)` | `Promise<boolean>`; `row` is `{ title, cwd }`. Focus a tab already in this window; never open a second copy of a conversation running elsewhere. `false` makes the core say it could not be brought to front |
| `canDeliver(sessionId)` | Whether this window can type into that conversation now |
| `deliverAnswer(sessionId, text, { deliveryId })` | `Promise<{ outcome, reason? }>`, see Answers |
| `planNotice()` | `null` or `{ title, description, detail, command, arguments }`: a row above the plan, such as a plugin that failed to install |
| `onDidChangePlanNotice` | `vscode.Event<void>` |
| `timeZone()` | The reader's IANA time zone, when the source knows it |

## Conversations

| Field | Meaning |
| --- | --- |
| `sessionId` | Unique within its source; a conversation is `(source id, sessionId)` |
| `title` | Title |
| `cwd` | Working folder; compared with the workspace folders through real paths |
| `state` | `'prompt'`, `'working'`, `'unread'` or `'idle'`; anything else reads as `'idle'` |
| `running` | Defaults to `true` |
| `lastActiveAt` | Epoch milliseconds or a date string |
| `hasPlan` | Used only when the source gives no `planPath` |

- The core derives "needs you" from the questions in the plan. Order: prompt, needs you, working, unread, idle.
- A stopped conversation (`running: false`) is listed while its plan has open rows, was written in the last 7 days, and its `cwd` is in a workspace folder.

## Plan files

| Item | Rule |
| --- | --- |
| Shape | The contract at the top of `src/workplan.js` |
| `format` | Plan format version, `1`; absent means 1. A higher one is drawn as far as format 1 goes, with a row saying the plan is newer |
| Row states | `discussing`, `todo`, `doing`, `waiting`, `parked`, `done`, `dropped`; no state reads as `todo` |
| Unknown state | Drawn with its name and "this version of Agent Work Plan does not know this state"; counted nowhere, and the Conversations row says how many |
| `waitingOn` | `user`, `build`, `someone`, `session`, `other` |
| Changes | Fields are only added; a changed meaning takes a new `format` |
| Writing | Nothing is asked of how a plan file is written. A file read halfway through a write does not parse, and the core shows the plan that last parsed while that file was written in the past 2 seconds; after that the row says it could not be read |
| Reading again | A file whose modification time and size are both unchanged is not parsed again. `Agent Work Plan: Refresh` parses every plan afresh |

## The conversation in front

- Every change of editor tabs offers the active tab to each source's `sessionForTab`.
- A session id moves the work plan view to that conversation; `''` shows that source with no plan; anything else from every source leaves the view where it was.
- The sources are asked in the order they registered, and the first with an answer has it.
- A source registering is offered the tab in front there and then, whether or not another source holds the focus: that tab may be its own, opened before its extension had finished starting.
- A source unregistering gives up the focus, and the tab is offered again to the sources that are left, never back to the one going away.
- `onDidFocus` moves the view a moment later, if `isFocused` (when present) still says so. An empty `sessionId` clears the view only when it shows that source.
- The latest signal wins, counted in the order the signals arrived: a focus report acted on after the reader has changed tabs is dropped.

## Answers

| Item | Rule |
| --- | --- |
| Folder | `~/.agent-work-plan/answers`, mode 0700, the same for every VS Code product and window of this user; made once a source is registered in a trusted window |
| Record | `<id>.json` with `format: 1`, `id`, `sourceId`, `sessionId`, `row`, `text`, `at`; one record per answer |
| Taking | Renaming `<id>.json` to `<id>.taken` in the same folder; only one window succeeds |
| Withdrawing | The sender renames an answer nobody took after 15 seconds, and on the way out renames back every one it sent that no window had taken |
| Too late to deliver | A receiving window throws away a record more than 15 seconds plus 5 seconds old rather than delivering it, and writes `notReceived` as its outcome |
| `deliveryId` | The record's `id`, passed to `deliverAnswer`; a source asked twice with one id types it once |
| Newer `format`, no `sourceId` | Not taken |

| `outcome` | Meaning | The Answer view |
| --- | --- | --- |
| `submitted` | The conversation has it as a message | Clears the draft |
| `drafted` | It is in the conversation's input box, not sent | Keeps the draft; says to press Enter there |
| `notReceived` | It did not get there; `reason` says why | Keeps the draft; copies the answer to the clipboard |
| `uncertain` | Handed over with no outcome in time, or the source cannot tell | Keeps the draft; says to look before sending again; no clipboard copy |

- `submitted` clears the draft only while the box still holds the text that was sent; anything typed while the answer was on its way is kept.
- A row that stopped asking, or whose conversation stopped, takes no answer: the view says so instead. A row now asking something else keeps its draft and drops the outcome of the question before it.

- A timeout is `uncertain`, never a failure: the answer may still arrive.
- Send is disabled for a question while its answer is on the way.
- The folder is read when it changes, on a 2 second interval of its own while a registered source could take an answer, and on `onDidFocus` and `onDidChangeConversations` from any source.

## Timing and limits

| Item | Value |
| --- | --- |
| Wait for a source's list before drawing its previous one | 3 seconds |
| A list call outstanding | Never abandoned; no new call until it settles; after 20 seconds the tree says it is still waiting |
| Change during a list call | One more call after it |
| Answer waiting to be taken | 15 seconds |
| Taken answer waiting for its outcome | 20 seconds |
| Answers folder read on its own interval | 2 seconds |
| Plan folder and conversation list events gathered up for | 250 ms |
| Conversations per list | 2000 |
| Plan file | 8 MB, regular files only |
| Logo file | 256 KB, regular files only |
| Ids | Non-empty, at most 200 characters, no space at either end, well-formed UTF-16 |

## Restricted Mode

- The views read and draw only.
- No answer is sent or taken, no icon is written, VS Code's files are left alone.
- Sources should not type into conversations either (`canDeliver` false).

## Installed with nothing that uses it

| Case | What the core does |
| --- | --- |
| No installed extension lists the core in `extensionDependencies`, none ever did on this profile | No view, no status bar entry, nothing written; one notice with Install Claude Code Extras and Install Codex Extras |
| One did before, none does now | One notice saying it does nothing alone and can be uninstalled in the Extensions view; no uninstall button |
| One is installed later | The views appear (`vscode.extensions.onDidChange`) |

- Being alone is decided in `activate()` from the installed manifests, before any source registers, so restored panels find their views.
- A disabled extension, or one installed on the other side of a remote connection, is not seen; hence no uninstall button.

## Versions and compatibility

| Rule | Detail |
| --- | --- |
| Marketplace version | Its first number is the protocol major: 1.0.0 implements protocol 1 |
| Adding | A new member goes under a feature name and is used only when the other side lists it; the major stays |
| Breaking | Removing a member or changing its meaning takes a new major |
| A source | Implements one major |
| The core, after a new major | Keeps the previous one in `accepts` for at least 90 days, and until every published feature extension has a release that supports the new one |

### Telling the user which extension to update

| Mismatch | Notice | Button |
| --- | --- | --- |
| Source newer than the core (`core-too-old`) | Update Agent Work Plan | Installs the gallery's newest Agent Work Plan when it accepts that protocol and allows this VS Code; otherwise opens its page with the reason |
| Core past the source (`source-too-old`) | Update the feature extension | Installs its newest release when that uses a protocol the core accepts; otherwise opens its page with the reason |

- Told once per pair of versions.
- The gallery is the Visual Studio Marketplace for VS Code, Open VSX for other editors.
- `workbench.extensions.installExtension` with the bare id installs the newest version of an installed extension (read from VS Code's sources, not tried against a live gallery).

## Installing, updating, uninstalling

Read from VS Code's sources:

- Installing a feature extension from the marketplace or from a `.vsix` looks the core up on the marketplace and installs it.
- When the core is not on the marketplace, or the marketplace cannot be reached, nothing reports an error and the core is not installed; the feature extension then does not start.
- Updating a feature extension does not update an installed core.
- Uninstalling a feature extension leaves the core.
- Uninstalling the core is refused while an extension depends on it.

| Release step | Detail |
| --- | --- |
| Publish the core | To the Visual Studio Marketplace and Open VSX, before any feature extension that needs it |
| Test without the marketplace | Install the core's `.vsix` first, then the feature extension's |
