# Agent Plus protocol, major 1

How an extension shows its agent's conversations in Agent Plus (`xnervwang.agent-plus`). Based on the work plan host protocol of Claude Code Plus (`docs/work-plan-host.md` at vscode-claude-code-extras `d2efd51`), renamed and renumbered.

## Roles

| Part | Who | Does |
| --- | --- | --- |
| Core | Agent Plus | Work plan view, Conversations view, Answer view, the Conversations and token mode entries in the status bar, the token mode setting, reading plan files, answers across windows, messages a feature extension sends into a conversation, notifications of conversations that need the user, opening a conversation in the window that shows it, VS Code's webview request limit |
| Source | Each feature extension (Claude Code Plus, Codex Plus) | One agent's conversations, plans, tabs, focus, answer typing |

## Setting up a feature extension

| Field in its `package.json` | Value | Why |
| --- | --- | --- |
| `extensionDependencies` | includes `xnervwang.agent-plus` | VS Code installs and activates the core first |
| `agentPlus.protocol` | the protocol major its source implements, `1` | The core reads it from the manifest before the extension activates, to say which extension to update |
| `extensionKind` | `["workspace"]` | `exports` cannot cross extension hosts; the core is `workspace` too |
| `capabilities.untrustedWorkspaces` | `{ "supported": "limited", ... }` | The core runs limited in Restricted Mode; an extension disabled there would leave it looking alone |

- Get the interface: `vscode.extensions.getExtension('xnervwang.agent-plus').exports.agentPlus`. The core is active by then; `await ext.activate()` is harmless.
- Call `registerSource(source)` once. Show views of your own only after `accepted` is true, under a context key you set then.
- A view the core does not draw (such as a session list) can go in the core's activity bar container, id `agentPlus`.
- Read each feature that adds to the agent's context through `effective()` in `src/token-mode.js`, copied in by `build/sync-shared.js`, and list its setting in that file's `SWITCHES`.

## Ids the core owns

| Kind | Id |
| --- | --- |
| Activity bar container | `agentPlus` |
| Panel container | `agentPlusPanel` |
| Views | `agentPlus.workPlan`, `agentPlus.conversations`, `agentPlus.answer` |
| Context key | `agentPlus.alone`: set to true only once the core finds nothing installed that depends on it and no source registered. The views, the status bar entries and the commands are hidden by `!agentPlus.alone`, so an unset key shows them: the key does not exist until the core has activated, and a window's panel is put back before that |
| Commands | `agentPlus.*` |
| Settings | `agentPlus.tokenMode`, `agentPlus.workPlanView`, `agentPlus.conversationsView`, `agentPlus.notifications.*`, `agentPlus.webviewRequestLimit` |

## The interface

| Member | Meaning |
| --- | --- |
| `family` | `'agent-plus'` |
| `version` | The core's marketplace version |
| `protocol` | The newest protocol major the core implements; also the first number of `version` |
| `accepts` | The source protocol majors the core accepts |
| `features` | Optional core capabilities by name: `'allConversations'` provides `allConversations()` (below). With `'waitingFor'`, the core reads each conversation's `waitingFor`, names the reason in its notices (see Notifications), and provides `announcesWaits()` (below). `'planSummary'` provides `planSummary()`, `onDidChangePlanSummary` (below) and the two commands in Plan bar. The features `'deliver'` and `'planPathOf'` each add a method of the same name. |
| `registerSource(source)` | Registers a source; never throws; returns a frozen result |
| `allConversations()` | With `'allConversations'`. Returns a frozen array with one entry per conversation from the last time the core read the sources' lists. For each source, the core includes the results of `listConversations()` and, if the source implements it, `listAllConversations()` (see Source members). Each entry has the form `{ sourceId, label, sessionId, title, steward, cwd, lastActiveAt }` (`sourceId` is the source's `id`; the other fields as in Conversations), where `label` is the source's label and `title` is the title displayed in the Conversations view. Kept current only while something listens to `onDidChangeAllConversations` (next row), and empty until then. A link to one of them opens with `agentPlus.openConversation` (see Opening a conversation from another extension) |
| `onDidChangeAllConversations` | With `'allConversations'`. `vscode.Event<void>`: a conversation came or went, or its title or folder changed. If only `lastActiveAt` changes, the event does not fire, but `allConversations()` returns the new value. Listening starts a pass at once |
| `announcesWaits()` | With `'waitingFor'`: whether this window tells the user when a conversation starts to wait for them (the core's views are shown in this window, the workspace is trusted, `agentPlus.notifications.enabled` and `.waiting` are on). If a source's agent has its own notice for the same wait, such as an approval request, the source skips that notice while `announcesWaits()` returns true and shows it when the call returns false. The source calls `announcesWaits()` again when the `agentPlus.notifications` settings or workspace trust change |
| `planSummary(sourceId, sessionId)` | With `'planSummary'`. Also accepts `{ sourceId, sessionId }` as one argument. Returns a frozen object with the figures for one conversation's plan bar (see Plan bar). Returns `null` if the source is not registered or the conversation's plan file is missing, cannot be parsed or has no rows. After excluding archived subtrees (see Plan files), the core also returns `null` if `total` is `0` and at least one remaining row has a state this version of the core does not know. A page calls it for the conversation it shows and passes the result to the bar's `update()` (see The page fragment). Calling `planSummary()` also makes the core follow that conversation's summary for changes, up to the 200 most recently requested (see Timing and limits). |
| `onDidChangePlanSummary` | With `'planSummary'`. `vscode.Event<{ sourceId, sessionId }>`: a summary requested through `planSummary()` changed, including to or from `null`. While the event has a listener, the core recalculates the summaries each time it rereads the plans: when a plan folder changes, on its 30-second tick, or when a source registers or goes away. When the event's `sourceId` and `sessionId` match the page's conversation, the page calls `planSummary()` again. |
| `deliver({ sourceId, sessionId, text })` | With `'deliver'`. Sends `text` to that conversation as a message, through the answers folder and whichever window can type into the conversation (see Answers). Returns a `Promise` of a frozen `{ outcome, reason }` and never rejects. `outcome` is one of the four in Answers; `reason` says why for `notReceived` and `uncertain`, and is `''` otherwise. `text` is a non-empty string of at most 20000 characters. Each call is one message: the core neither drops a repeated text nor retries. In Restricted Mode, while the window is closing, or with an argument it cannot use, the call resolves to `notReceived` at once. Each call settles within about 40 seconds (see Timing and limits). When this window closes, pending calls settle immediately. The outcome is `uncertain` for a message a window has already taken and `notReceived` for a message still waiting to be taken. |
| `planPathOf(sourceId, sessionId)` | With `'planPathOf'`. Like `planSummary()`, it accepts the two IDs separately or as `{ sourceId, sessionId }`. Returns the absolute path the source's `planPath(sessionId)` (see Source members) gives for that conversation, or `''` when the source is not registered in this window, gives nothing or a relative path, or throws |

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
| `features` | Optional capability names the source implements. `'brief'`: its conversations keep a brief in their plans (see Plan files), so clicking a conversation's row shows it in the Answer view instead of going to the conversation. The core calls `shows` and `openHere` (rows below) only when they are listed here |
| `id` | Source id, such as `'codex'` or `'claude-code'` |
| `label` | Shown in tooltips and in the work plan view's description |
| `extensionId` | The extension that registered it, such as `'xnervwang.codex-plus'`; used for update notices |
| `logo` | `{ light, dark }` SVG `vscode.Uri` values, read from the agent's own extension; drawn with the conversation's activity dot when more than one source is registered |
| `planPath(sessionId)` | Absolute path of the conversation's plan file, or `null` |
| `planDir()` | Folder of the plan files; the core watches it, with the folder itself as the watcher's base and `*.json` as the pattern, and never writes or deletes in it. A folder that does not exist yet is watched once it appears |
| `sessionForTab(tab)` | A session id for a tab showing that conversation; `''` for this source's tab with no conversation yet; anything else for a tab not its own. Asked again for the same tab object once its label changes, and on every tab event while the last answer was `''`: a tab keeps one object for its whole life, so a new conversation answers `''` and then an id without ever becoming a different tab |
| `onDidFocus` | `vscode.Event<{ sessionId }>` when a conversation comes to front outside an editor tab, and when the tab in front has a conversation at last: see below |
| `isFocused(sessionId)` | Whether that conversation is still in front; the core asks before taking an `onDidFocus` report |
| `listConversations()` | `Promise<Conversation[]>`; the array may carry a string `problem`, shown above the source's rows |
| `onDidChangeConversations` | `vscode.Event<void>` |
| `reveal(sessionId, row)` | `Promise<boolean>`; `row` is `{ title, cwd }`. Focus a tab already in this window; never open a second copy of a conversation running elsewhere. `false` makes the core try the other windows (see Notifications, Opening) |
| `canDeliver(sessionId)` | Whether this window can type into that conversation now |
| `deliverAnswer(sessionId, text, { deliveryId })` | `Promise<{ outcome, reason? }>`, see Answers |
| `planNotice()` | `null` or `{ title, description, detail, command, arguments }`: a row above the plan, such as a plugin that failed to install |
| `onDidChangePlanNotice` | `vscode.Event<void>` |
| `timeZone()` | The reader's IANA time zone, when the source knows it |
| `listAllConversations()` | `Promise<Conversation[]>`, the same shape as `listConversations()`, covering every conversation on this machine rather than this window's, with states every window agrees on. Read for notifications and for `allConversations()` only; without it the core reads `listConversations()` |
| `shows(sessionId)` | Whether this window shows that conversation where `sessionForTab` cannot see it, such as a sidebar (see Opening) |
| `openHere(sessionId, row)` | `Promise<boolean>`: open the conversation in this window, after no window took the request and the user picked Open it here (see Notifications, Opening) |
| `open(sessionId, row)` | `Promise<'here'\|'sent'\|'nowhere'>`: bring the conversation to the front in whichever window shows it, and that window with it. Without it the core does this itself through `reveal` in each window (see Notifications) |

## Conversations

| Field | Meaning |
| --- | --- |
| `sessionId` | Unique within its source; a conversation is `(source id, sessionId)` |
| `title` | Title. Before showing it, the core removes any crown, envelope or old bell in it and puts one crown after a steward's title, before the envelope (see `steward`; `withMarks()` in `src/title-marks.js`) |
| `steward` | Optional boolean: the conversation is a steward, one the user has given other conversations to look after |
| `cwd` | Working folder; compared with the workspace folders through real paths |
| `state` | `'prompt'`, `'working'`, `'unread'` or `'idle'`; anything else reads as `'idle'` |
| `activity` | Optional. `'working'` (a turn is running), `'background'` (the turn is over and only background work runs), `'waiting'` (waiting for the user: a permission prompt, a choice) or `'stopped'` (stopped, no background work). Without it, or with any other value, it follows `state`: `prompt` is waiting, `working` is working, `unread` and `idle` are stopped |
| `waitingFor` | Optional, read only while `activity` is `waiting`: what it waits for. `{ kind: 'permission', tool }` approval of a tool call, `tool` the tool's name (up to 80 characters) when the source knows it; `{ kind: 'question' }` an answer to a question the agent asked; `{ kind: 'plan' }` a plan the agent made, waiting for the user to review it; `{ kind: 'choice' }` any other choice the agent's interface asks for; `{ kind: 'planQuestion' }` a question in the conversation's plan, a reason the core also sets itself when the plan makes the conversation wait (see `lastUserAt`). Anything else counts as no reason |
| `unseen` | Optional boolean: the conversation has a reply the user has not seen. Without it, `state` is `unread`. It does not depend on `activity`: a working conversation can have one |
| `lastUserAt` | Optional. When the user's last message was sent, in epoch milliseconds or a date string. A question in the plan (`waitingOn: user`) asked after it makes the conversation `waiting`; a question asked before it does not. Without it, the plan does not change `activity` |
| `running` | Defaults to `true`. A conversation not running has stopped, whatever its `activity` says, unless its plan has a question asked after `lastUserAt` |
| `lastActiveAt` | Epoch milliseconds or a date string |
| `lastReplyAt` | Optional. When the agent's last reply landed, in the same forms. Notifications use it instead of `lastActiveAt` to detect a turn that started and ended between two reads (see Notifications, When) |
| `hasPlan` | Used only when the source gives no `planPath` |

- The core derives "needs you" from the questions in the plan. Order: prompt, needs you, working, unread, idle.
- The Conversations view draws `activity` in the row's icon: a green dot working, a green ring background, a red dot waiting, nothing stopped. An envelope at the end of the row shows `unseen`: 📩 (U+1F4E9) in a dark theme, and in a light theme the plain envelope's text form ✉︎ (U+2709 U+FE0E), since a colour emoji font draws both envelopes white there; `src/envelope.js` picks between them for any extension that draws the envelope too.
- A stopped conversation (`running: false`) is listed while its plan has open rows, was written in the last 7 days, and its `cwd` is in a workspace folder.

## Notifications

| Item | Rule |
| --- | --- |
| What counts | A running conversation that is `waiting`, or `stopped` and `unseen` |
| Shared | Each window writes `attention/<window>.json` under the shared folder. While its notifications are on or something listens to `onDidChangeAllConversations`, the window reads its sources' lists and writes their running conversations, excluding those stopped and not `unseen`. Otherwise it writes an empty list. Each conversation is written with `state`, `activity`, `unseen`, `steward` and, while waiting, `waitingFor`. A file is rewritten at least every 20 seconds; one older than a minute is a window that has gone. While a window has the focus, `front` lists the conversations in its file that it shows in front. The `settled` list records `[sourceId, sessionId, time]` for each conversation the window notified the user about in the last day or would have notified them about if the conversation had not already been in front of them. Every window reads all of them. An item without `activity`, from an older version, is read from `state`: `prompt` is waiting, `unread` is stopped and `unseen`. An item without `steward` is a steward's when its title starts with the crown. When windows report one waiting conversation with different reasons, a `permission` with its `tool` or any other kind wins over a `permission` without one |
| When | A conversation that becomes `waiting`. A conversation that goes from `working` or `background` to `stopped` and `unseen`, once it has stayed that way for 5 seconds; one that turns up `stopped` and `unseen` with a `lastReplyAt` (or, without it, a `lastActiveAt`) newer than any this window read before for it counts too, as its turn ran between two reads. Not one that only becomes `unseen`, nor one that starts working again within those 5 seconds. An older window's `unread` is announced when it appears, after the 5 seconds. What a window reads in its first 10 seconds, and a conversation whose window went away and came back the same within two minutes, is not new. A notice says what the windows report when it is shown, not when the wait was first seen; if no window has reported the `tool` for a `permission` wait, the core waits for the tool name until 3 seconds after the wait was first seen |
| Who shows it | Only the window with the focus, after waiting 2 seconds for others that change with it, one notice for each conversation. The window skips the notice if it shows the conversation in front (`isFocused`), in any tab (`sessionForTab`) or where only its source can see it, such as a side bar (`shows`): the user is already looking at a conversation shown in front; for the others, the user is already in the window where they answer the conversation, and its tab dot and the count show that it needs attention. That holds for a reply left unread as for a wait. Every window's status bar entry counts the waiting conversations and the stopped `unseen` ones, less the conversations the window with the focus shows in front |
| While no window has the focus | Each window keeps what it would have shown. The first window that gets the focus again shows each pending notice once if the conversation still needs the user. The window skips conversations it shows and any that no longer need the user, such as those with an answered wait or a reply the user has read. It also skips a pending notice if another window's `settled` list has an entry for that conversation from after this window saved the notice. The next window that gets the focus does not repeat what the first window has told the user about |
| Text | `"<title>" is waiting for you to approve <tool>.`, `is waiting for your approval.`, `has a question for you.`, `has a plan for you to review.`, `is waiting for you to choose.`, `has a question for you in its plan.`, or `is waiting for you.` without a reason; `"<title>" finished.` for an unread reply. With more than one source registered, the source's label comes first: `Codex: "<title>" finished.` |
| Buttons | A plain message with two buttons, Open and Dismiss. Open brings that notice's conversation to the front (see Opening). The core cannot close the message: VS Code moves it into its notification list after a few seconds |
| Opening | `open()` when the source has it; else `reveal` in this window, then a request in `open/` under the shared folder that the window showing the conversation takes; that window reveals the conversation and brings itself to the front with VS Code's command line. A request nobody takes in 5 seconds is withdrawn, and the user is told no window has the conversation, with an Open it here button when the source lists `openHere` in its `features` |
| Settings | `agentPlus.notifications.enabled`, `.finished`, `.waiting` |

## Opening a conversation from another extension

`agentPlus.openConversation` takes one argument and does not appear in the command palette.

| Item | Detail |
| --- | --- |
| Use | Opens a conversation as the arrow on its row in the Conversations view does. A feature extension runs it with `vscode.commands.executeCommand`, for instance when the user clicks a link to a conversation from `allConversations()` |
| Argument | `{ sourceId, sessionId, title, cwd }`. `sourceId` is the source's `id` and `sessionId` the conversation's, as in `allConversations()`. `title` and `cwd` are optional; a value that is not a string counts as `''`. The core passes them to the source as the `row` of `open()` or `reveal`, and uses `title` in the message below |
| Which window | The command goes to the source registered under `sourceId` in the window that runs it. If that source has `open()`, the core calls only that; any result other than `'nowhere'` counts as opened. If it has no `open()`, the core calls `reveal` in this window and, if that does not show the conversation, asks the other VS Code windows on this machine (see Notifications, Opening): the window that shows the conversation reveals it and comes to the front. |
| Not open anywhere | If `open()` resolves `'nowhere'` or throws, or no window takes the request within 5 seconds, the core shows `"<title>" is not open in any VS Code window on this machine.`, with `sessionId` in place of an empty `title`. When the source lists `openHere` in its `features`, the message has an Open it here button that calls `openHere(sessionId, row)` in this window. The command does not wait for the user to pick |
| Nothing happens | The argument is missing or has no `sessionId`, or no source with that `sourceId` is registered in this window: its extension is not installed, has not registered yet, or was refused. Nothing is shown to the user |
| Result | The promise `executeCommand` returns resolves to `undefined` when `open()` settles, when `reveal` shows the conversation in this window, when another window takes the request, or when the 5 seconds pass. It does not reject; an error goes to the Agent Plus output channel |
| Without Agent Plus | When the core is not installed or is disabled, VS Code rejects `executeCommand` with `command 'agentPlus.openConversation' not found` (the message in VS Code 1.147). An extension that works without the core checks `vscode.extensions.getExtension('xnervwang.agent-plus')` first |

## Plan files

| Item | Rule |
| --- | --- |
| Authority | This section. `src/workplan.js` is the core's reading of it, and a source reading its own plans keeps to the same states, the same `waitingOn` values and the same limits |
| Shape | The contract at the top of `src/workplan.js` |
| `format` | Plan format version, `1`; absent means 1. A higher one is drawn as far as format 1 goes, with a row saying the plan is newer |
| Row states | `discussing`, `todo`, `doing`, `waiting`, `parked`, `done`, `dropped`; no state reads as `todo` |
| Unknown state | Drawn with its name and "this version of Agent Plus does not know this state"; counted nowhere, and the Conversations row says how many |
| `waitingOn` | `user`, `build`, `someone`, `session`, `other` |
| `brief` | Optional, at the top of the file: `summary`, `summaryAt`, `status` (`doing`, `progress`, `next`) and `statusAt`, the conversation's account of itself. The plugins write it with widths of 400, and 80, 100 and 60, where a CJK character counts 2 and any other 1. A part missing or of the wrong type reads as not written |
| Reading the brief | Shown for a source that lists `'brief'`. A part not written is put together from the plan (top rows; `doing` rows with their notes; last activity) and marked as such. The status is marked as possibly out of date when the conversation's `lastActiveAt` is more than 5 minutes after `statusAt` |
| Closed rows moved out | A subtree whose rows are all `done` or `dropped`, the newest closed more than a day ago, may be moved to `closed/<session id>.json` in the plan's folder: `{ "format": 1, "nodes": [...] }`, each row there with `row`, its number in the plan. The plan keeps a placeholder in its place, `{ "title", "state", "archived": true }` with the title cut to 80 characters, so no row number changes. The plugins' `plan-row.py` moves rows out and back |
| Reading moved rows | The core reads both files and puts each row back where its placeholder is, so the views show the plan as it was. A placeholder whose row is not in that file is drawn as a closed row with its short title. A change to that file counts as a change to the plan |
| Changes | Fields are only added; a changed meaning takes a new `format` |
| Writing | Nothing is asked of how a plan file is written. A file read halfway through a write does not parse, and the core shows the plan that last parsed while that file was written in the past 2 seconds; after that the row says it could not be read |
| Reading again | A file whose modification time and size, and those of its `closed/` file, are all unchanged is not parsed again. `Agent Plus: Refresh` parses every plan afresh |

## The conversation in front

- Every change of editor tabs offers the active tab to each source's `sessionForTab`.
- A session id moves the work plan view to that conversation; `''` shows that source with no plan; anything else from every source leaves the view where it was.
- The sources are asked in the order they registered, and the first with an answer has it.
- A source registering is offered the tab in front there and then, whether or not another source holds the focus: that tab may be its own, opened before its extension had finished starting.
- A source unregistering gives up the focus, and the tab is offered again to the sources that are left, never back to the one going away.
- `onDidFocus` moves the view a moment later, if `isFocused` (when present) still says so. An empty `sessionId` clears the view only when it shows that source.
- The latest signal wins, counted in the order the signals arrived: a focus report acted on after the reader has changed tabs is dropped.

### `isFocused`

- A source with no reliable signal for a conversation in its own sidebar may answer from the last focus signal it saw: whether that signal was for this conversation.
- It must answer false once the active editor tab is a tab that is not its own. Otherwise the core, asking a moment after a report, pulls the view back to a conversation the reader has left.
- Answering false is never wrong in itself: the core then leaves the view where it is.

### Telling the core a tab's conversation is known now

- `sessionForTab` answers `''` for a tab of this source with no conversation yet, such as a new one before its first message.
- When that tab does have a conversation, the source fires `onDidFocus` with the new `sessionId`. The core offers the tab in front to every source again before it acts on the report, so the tab is picked up whether or not `isFocused` says yes.
- There may be no tab event to carry this: a tab keeps one object for its whole life, and VS Code fires nothing when only the conversation behind it changed. The core also asks a tab again on any tab event while the last answer for it was `''`, so a source that cannot fire this is not stuck.

## Answers

| Item | Rule |
| --- | --- |
| Folder | `~/.agent-work-plan/answers`, mode 0700, the same for every VS Code product and window of this user; made once a source is registered in a trusted window |
| Record | `<id>.json` with `format: 1`, `id`, `sourceId`, `sessionId`, `row`, `text`, `at`; one record per answer. Records from `deliver()` omit `row` |
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
- A message sent through `deliver()` gets the same outcomes, given to its caller: nothing is shown in the Answer view and nothing is put on the clipboard.
- Send is disabled for a question while its answer is on the way.
- The folder is read when it changes, on a 2 second interval of its own while a registered source could take an answer or a `deliver()` call waits for its outcome, and on `onDidFocus` and `onDidChangeConversations` from any source.

## Plan bar

The core provides the plan summary, a page fragment that draws the plan bar, and two commands for clicks. The bar shows the summary for the conversation in the panel just above the agent's input box. Claude Code Plus draws it in Claude Code's panel and Codex Plus in the Codex page. Each feature extension owns its setting for turning the bar off; in Claude Code Plus it is `claudeCodePlus.show.planBar`.

### The summary

- Plan order is file order, with parents before their children.
- `number` comes from the row's place in the file, as in the Work plan view: `1`, `2.1.1`.
- An open row is a counted row that is not `done`.

| Field | Meaning |
|---|---|
| `total` | Number of counted rows. Excludes rows in `dropped`, rows in states this version of the core does not know, archived rows, and all rows under archived rows. |
| `done` | Number of counted rows in `done`. |
| `counts` | `{ discussing, todo, doing, waiting, parked, done }`: number of counted rows in each state. |
| `current` | `{ number, title, state, dim }` or `null`. The deepest `doing` row wins; plan order breaks ties. With no `doing` row, the core checks `waiting`, `discussing` and `todo` in that order and takes the first row in plan order from the first state that has one. If only `parked` rows remain besides `done` rows, it takes the first `parked` row with `dim: true`; otherwise `dim` is `false`. `current` is `null` when no row is open. |
| `allDone` | `true` when no row is open and no row outside an archived subtree is in a state this version of the core does not know. This includes `total` of `0` when every row is archived or `dropped`. |
| `questions` | Number of rows waiting for the user's answer. The Conversations entry in the status bar counts the same rows, across the conversations the Conversations view lists, for its `N to decide`: rows in `waiting` or `discussing` with `waitingOn: user`. |
| `open` | Up to 30 counted rows that are not `done`, in plan order. Each is `{ number, title, state, depth }`, with `depth` of `1` for a top-level row, `2` for its children, and so on. |

- The core leaves archived subtrees (see Plan files) out of every figure, but each `"archived": true` placeholder keeps its place in the numbering of later rows.
- The core cuts titles to 200 characters.

### The page fragment

`build/sync-shared.js` copies `shared/page/plan-bar.js` into each feature extension with the other shared files.

| Part | Detail |
|---|---|
| Object | The fragment exposes one global, `agentPlusPlanBar`, to keep its members from colliding with names in either page. It uses ASCII and ES5 like the page scripts and is also a module under Node. |
| `create(document, { onOpen, onAnswer, css })` | Returns `{ el, update(summary), fit(width), model(), destroy() }`. The page places `el`, the bar's element, and can add `css`, a string of CSS declarations, to the bar's own style. Clicks and keys below says when each callback runs. |
| `update(summary)` | Draws the summary. `null` hides the bar. |
| `fit(width)` | Supplies the bar's own width in CSS pixels when the page knows it before layout. The fragment also watches its own width with a `ResizeObserver` when one is available. |
| `model()` | Returns what the bar last drew, in the terms of the rows below: whether it is in the compact form (`COMPACT_BELOW`), the track's segments, the open count, the current row, the question count text, the screen-reader label and the list shown on hover; `null` while the bar is hidden. |
| `destroy()` | Removes the bar and its hover list from the page. |
| Contents, left to right | A list icon and `Plan`; a track with one segment per open state (`doing`, `waiting`, `discussing`, `todo`, `parked`), each as long as its share of open rows; the open count (`total` minus `done`, not the length of `open`), such as `8 open`; the current row with its number and state icon, grey when `dim`; a red part with a dot and `N to decide` when `questions` is above `0`; an arrow. When no row is open, the track is empty and the count is hidden. If `allDone` is `true`, a green check with `All rows done` replaces the current row; otherwise that space stays empty. |
| Colours | The bar reads the Work plan view's state icon colours from the page's `--vscode-*` variables: `charts.green` only for the `All rows done` check, `charts.blue` for `doing`, `charts.orange` for `waiting`, `charts.yellow` for `discussing`, `charts.purple` for `todo`, and `descriptionForeground` for `parked`. The red part uses `#ef4444`, the colour both feature extensions use for the tab dot when a conversation waits for the user. |
| `COMPACT_BELOW` | Both feature extensions use this exported constant of 400 CSS pixels. Below that width, the bar keeps `Plan`, the open count, the question count as a number in the red part, and the arrow. The compact bar returns to full size at `COMPACT_BELOW` plus `HYSTERESIS` (24 CSS pixels), so small width changes near the threshold do not switch it back and forth. |
| Layout | The bar fills the width of its containing element and stays on one line, 26 CSS pixels high. The track stays `TRACK_WIDTH` (72 CSS pixels) wide regardless of row count. Each segment's width follows its state's share of the open rows, with a minimum of `SEGMENT_MIN` (2 CSS pixels) so a state with one row among many stays visible. The count uses equal-width digits in a box sized for `COUNT_ROOM` (`999 open`), so the title stays in place as the count grows. The current row takes the remaining width and ends in an ellipsis if it does not fit. |
| What it counts | In the fragment, `SEGMENTS` sets the states drawn on the track and `countOf()` sets the count. The summary includes `done` and `total`, so showing `done` out of `total` instead requires changes only to `SEGMENTS` and `countOf()`. |
| Hover | After the pointer rests on the bar for 350 ms, the first line shows the current row's title as it appears in the summary, up to 200 characters, without the ellipsis the bar may add. The next line gives the number of rows not done. The list shows up to `MAX_LIST` (30) rows from `open`, each with its state icon and number, indented by depth, followed by `and N more open` if more rows are open. |
| Clicks and keys | A click, `Enter`, or `Space` on the bar calls `onOpen`. On the red part, the same actions call only `onAnswer`. |

### The commands

In Claude Code Plus and Codex Plus, `onOpen` runs `agentPlus.showWorkPlanOf` and `onAnswer` runs `agentPlus.answerQuestionOf`, each with the conversation's `{ sourceId, sessionId }`. Neither command appears in the command palette.

| Command | Does |
|---|---|
| `agentPlus.showWorkPlanOf` | Moves the Work plan view to the conversation, as a focus report does, and runs `agentPlus.workPlan.focus` to reveal the view. The next editor tab change moves the view as usual. |
| `agentPlus.answerQuestionOf` | Reads the plan as it is now and shows the first question in the Answer view, in the same plan order the Conversations view uses. This works even for a conversation the Conversations view leaves out, such as one outside the window's folders. If the source's last list omits the conversation, the core calls the source's `listConversations()` once more and waits up to 3 seconds (the same limit the Conversations view uses) before treating the conversation as not running. If there is no question, a message says so. The Answer view's Go to the conversation button opens the conversation through its source's `open()` when the source provides it. |

## Timing and limits

| Item | Value |
| --- | --- |
| Wait for a source's list before drawing its previous one | 3 seconds |
| A list call outstanding | Never abandoned; no new call until it settles; after 20 seconds the tree says it is still waiting |
| Change during a list call | One more call after it |
| Answer waiting to be taken | 15 seconds |
| Taken answer waiting for its outcome | 20 seconds |
| Answers folder read on its own interval | 2 seconds |
| Message sent through `deliver()` | 20000 characters |
| A `deliver()` call settles | Within about 40 seconds: 15 to be taken, 20 for the outcome, 5 to spare |
| Plan folder and conversation list events gathered up for | 250 ms |
| Conversations per list | 2000 |
| Plan file | 8 MB, regular files only |
| Logo file | 256 KB, regular files only |
| Ids | Non-empty, at most 200 characters, no space at either end, well-formed UTF-16 |
| Plan summaries followed for changes | 200, the most recently requested |
| Open rows in a summary | 30 |

## Restricted Mode

- The views read and draw only.
- No answer is sent or taken, no icon is written, VS Code's files are left alone.
- Sources should not type into conversations either (`canDeliver` false).
- `deliver()` resolves to `notReceived` at once; `planPathOf()` answers as usual.

## Installed with nothing that uses it

| Case | What the core does |
| --- | --- |
| No installed extension lists the core in `extensionDependencies`, none ever did on this profile | No view, no status bar entry, nothing written; one notice with a button for each extension known to use the core, named as the Extensions view names it |
| One did before, none does now | One notice saying it does nothing alone and can be uninstalled in the Extensions view; no uninstall button |
| One is installed later | The views appear (`vscode.extensions.onDidChange`) |
| Restricted Mode | The views are hidden the same way, but nothing is said and nothing recorded as said: VS Code disables an extension whose own dependency is disabled, so an untrusted window cannot see a dependent that is installed, and a notice is said once for good. Worked out again on `onDidGrantWorkspaceTrust` |

- Being alone is read from the installed manifests, synchronously, needing no other extension to have activated.
- The notice waits a few seconds, and waits again on every `vscode.extensions.onDidChange`: a remote installs extensions one at a time, and this one can arrive first. A window that then finds a dependent takes back a notice already recorded as said.
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
| Source newer than the core (`core-too-old`) | Update Agent Plus | Installs the gallery's newest Agent Plus when it accepts that protocol and allows this VS Code; otherwise opens its page with the reason |
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
