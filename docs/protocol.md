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
| `features` | Optional core capabilities by name: `'allConversations'` provides `allConversations()` (below). With `'waitingFor'`, the core reads each conversation's `waitingFor`, names the reason in its notices (see Notifications), and provides `announcesWaits()` (below). `'planSummary'` provides `planSummary()`, `onDidChangePlanSummary` (below) and the two commands in Plan bar. The features `'deliver'` and `'planPathOf'` each add a method of the same name. `'stewards'` provides `stewardOf()`, and `'stewardList'` provides `stewardsOf()` (rows below). Either feature provides the `onDidChangeStewards` event. With `'prefill'`, the core adds a pen to each Work plan row when the source of the displayed conversation also lists `'prefill'` (see Writing about a row). |
| `registerSource(source)` | Registers a source; never throws; returns a frozen result |
| `allConversations()` | With `'allConversations'`. Returns a frozen array with one entry per conversation from the last time the core read the sources' lists. For each source, the core includes the results of `listConversations()` and, if the source implements it, `listAllConversations()` (see Source members). Each entry has the form `{ sourceId, label, sessionId, title, steward, cwd, lastActiveAt }` (`sourceId` is the source's `id`; the other fields as in Conversations), where `label` is the source's label and `title` is the title displayed in the Conversations view. Kept current only while something listens to `onDidChangeAllConversations` (next row), and empty until then. A link to one of them opens with `agentPlus.openConversation` (see Opening a conversation from another extension) |
| `onDidChangeAllConversations` | With `'allConversations'`. `vscode.Event<void>`: a conversation came or went, or its title or folder changed. If only `lastActiveAt` changes, the event does not fire, but `allConversations()` returns the new value. Listening starts a pass at once |
| `announcesWaits()` | With `'waitingFor'`: whether this window tells the user when a conversation starts to wait for them (the core's views are shown in this window, the workspace is trusted, `agentPlus.notifications.enabled` and `.waiting` are on). If a source's agent has its own notice for the same wait, such as an approval request, the source skips that notice while `announcesWaits()` returns true and shows it when the call returns false. The source calls `announcesWaits()` again when the `agentPlus.notifications` settings or workspace trust change |
| `planSummary(sourceId, sessionId)` | With `'planSummary'`. Also accepts `{ sourceId, sessionId }` as one argument. Returns a frozen object with the figures for one conversation's plan bar (see Plan bar). Returns `null` if the source is not registered or the conversation's plan file is missing, cannot be parsed or has no rows. After excluding archived subtrees (see Plan files), the core also returns `null` if `total` is `0` and at least one remaining row has a state this version of the core does not know. A page calls it for the conversation it shows and passes the result to the bar's `update()` (see The page fragment). Calling `planSummary()` also makes the core follow that conversation's summary for changes, up to the 200 most recently requested (see Timing and limits). |
| `onDidChangePlanSummary` | With `'planSummary'`. `vscode.Event<{ sourceId, sessionId }>`: a summary requested through `planSummary()` changed, including to or from `null`. While the event has a listener, the core recalculates the summaries each time it rereads the plans: when a plan folder changes, on its 30-second tick, or when a source registers or goes away. When the event's `sourceId` and `sessionId` match the page's conversation, the page calls `planSummary()` again. |
| `deliver({ sourceId, sessionId, text })` | With `'deliver'`. Sends `text` to that conversation as a message, through the answers folder and whichever window can type into the conversation (see Answers). Returns a `Promise` of a frozen `{ outcome, reason }` and never rejects. `outcome` is one of the four in Answers; `reason` says why for `notReceived` and `uncertain`, and is `''` otherwise. `text` is a non-empty string of at most 20000 characters. Each call is one message: the core neither drops a repeated text nor retries. In Restricted Mode, while the window is closing, or with an argument it cannot use, the call resolves to `notReceived` at once. Each call settles within about 40 seconds (see Timing and limits). When this window closes, pending calls settle immediately. The outcome is `uncertain` for a message a window has already taken and `notReceived` for a message still waiting to be taken. |
| `planPathOf(sourceId, sessionId)` | With `'planPathOf'`. Like `planSummary()`, it accepts the two IDs separately or as `{ sourceId, sessionId }`. Returns the absolute path the source's `planPath(sessionId)` (see Source members) gives for that conversation, or `''` when the source is not registered in this window, gives nothing or a relative path, or throws |
| `stewardOf(sourceId, sessionId)` | With `'stewards'`. Like `planSummary()`, it accepts the two IDs separately or as `{ sourceId, sessionId }`. Returns a frozen `{ sourceId, sessionId }`: the steward that looks after that conversation. That is not the conversation's own `steward` field, which says the conversation is a steward itself (see Conversations). The call is synchronous. The core asks each source registered in this window that lists `'stewards'`, in the order they registered, and returns the first answer whose two fields are usable IDs (see Ids in Timing and limits); an answer of any other form, or a source that throws, is skipped. Returns `null` when no source answers. That happens when Claude Code Plus, the extension that keeps the stewards, is not installed or has not registered in this window yet. Also `null` for an ID that is not usable, and in Restricted Mode |
| `stewardsOf(sourceId, sessionId)` | With `'stewardList'`. Takes its arguments as `stewardOf()` does. Returns a frozen array of frozen `{ sourceId, sessionId, title }`: every steward that looks after that conversation, as far as the sources registered in this window know. The call is synchronous. The core asks each source that lists `'stewardList'` (see Source members) in registration order. It joins the lists in that order, preserves the order of entries within each list, and keeps only the first occurrence of each steward. The core skips any entry without two usable IDs. The core trims `title` and limits it to 200 characters if it is a string; otherwise it uses the empty string. The call returns at most 20 entries. It returns an empty array if no source answers, either input ID is unusable, or the window is in Restricted Mode. |
| `onDidChangeStewards` | With `'stewards'` or `'stewardList'`. `vscode.Event<void>`: `stewardOf()` or `stewardsOf()` may answer differently. Fires when a source that lists `'stewards'` or `'stewardList'` fires its own `onDidChangeStewards` (see Source members), registers or goes away, and when the workspace is trusted while such a source is registered. Several of these in one turn of the event loop fire it once |

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
| `features` | Optional capability names the source implements. `'brief'`: its conversations keep a brief in their plans (see Plan files), so clicking a conversation's row shows it in the Answer view instead of going to the conversation. The core calls `shows`, `shownIn` and `openHere` (rows below) only if the source lists the corresponding name here. The core listens to the source's `onDidChangeStewards` if the source lists `'stewards'` or `'stewardList'`. |
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
| `prefill(sessionId, text)` | With `'prefill'` in `features`. `Promise<{ outcome, reason? }>`, see Writing about a row |
| `planNotice()` | `null` or `{ title, description, detail, command, arguments }`: a row above the plan, such as a plugin that failed to install |
| `onDidChangePlanNotice` | `vscode.Event<void>` |
| `timeZone()` | The reader's IANA time zone, when the source knows it |
| `listAllConversations()` | `Promise<Conversation[]>`, the same shape as `listConversations()`, covering every conversation on this machine rather than this window's, with states every window agrees on. A call must not report a state older than one an earlier call reported: the core merges every window's report and a `waiting` one outranks the rest, so a wait reported after it ended keeps the conversation waiting in every window, and its next wait is not announced. Read for notifications and for `allConversations()` only; without it the core reads `listConversations()` |
| `shows(sessionId)` | Whether this window shows that conversation where `sessionForTab` cannot see it, such as a sidebar (see Opening). `true` says only that it is shown here: the session list's hover then says Open in this window without a place, and once it is closed it reopens where the source opens first |
| `shownIn(sessionId)` | Where a conversation `shows` answered `true` for is: `'sidebar'`, or `'tab'` for a tab `sessionForTab` could not match; anything else is no place. The session list's hover says Open in this window, in the sidebar only for `'sidebar'`, and a closed conversation reopens at the place given |
| `openHere(sessionId, row)` | `Promise<boolean>`: open the conversation in this window, after no window took the request and the user picked Open it here (see Notifications, Opening) |
| `open(sessionId, row)` | `Promise<'here'\|'sent'\|'nowhere'>`: bring the conversation to the front in whichever window shows it, and that window with it. Without it the core does this itself through `reveal` in each window (see Notifications) |
| `stewardOf(sourceId, sessionId)` | With `'stewards'`: this source's answer for the core's `stewardOf()` about that conversation, `{ sourceId, sessionId }` or `null`. Asked about a conversation of any source, and the steward may belong to another source. Synchronous |
| `stewardsOf(sourceId, sessionId)` | If the source lists `'stewardList'`, it returns its own list of stewards for that conversation. The core's `stewardsOf()` joins these lists. Each list is an array of `{ sourceId, sessionId, title }`. The steward who spoke with the user most recently comes first. `title` is the name the user knows the steward by. A source that also lists `'stewards'` answers `stewardOf` with the first entry of this list. Asked about a conversation of any source. Synchronous |
| `onDidChangeStewards` | With `'stewards'` or `'stewardList'`: `vscode.Event<void>` when an answer from `stewardOf` or `stewardsOf` may have changed, including a steward's title and the order of the list |

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

- The core derives "needs you" from the questions in the plan. In the Conversations view, the conversation in front comes first even if it is not running. This is the conversation the Work plan view shows. The rest follow in this order: prompt, needs you, working, unread, idle.
- The Conversations view draws `activity` in the row's icon: a green dot working, a green ring background, a red dot waiting, nothing stopped. An envelope at the end of the row shows `unseen`: 📩 (U+1F4E9) in a dark theme, and in a light theme the plain envelope's text form ✉︎ (U+2709 U+FE0E), since a colour emoji font draws both envelopes white there; `src/envelope.js` picks between them for any extension that draws the envelope too.
- A stopped conversation (`running: false`) is listed while its plan has open rows, was written in the last 7 days, and its `cwd` is in a workspace folder.

## Notifications

| Item | Rule |
| --- | --- |
| What counts | A running conversation that is `waiting`, or `stopped` and `unseen` |
| Shared | Each window writes `attention/<window>.json` under the shared folder. While its notifications are on or something listens to `onDidChangeAllConversations`, the window reads its sources' lists and writes their running conversations, excluding those stopped and not `unseen`. Otherwise it writes an empty list. Each conversation is written with `state`, `activity`, `unseen`, `steward`, while waiting `waitingFor`, and `here: true` when the window shows it (in front, in a tab, or where only its source can see it). A file is rewritten at least every 20 seconds; one older than a minute is a window that has gone. While a window has the focus, `front` lists the conversations in its file that it shows in front. The `settled` list records `[sourceId, sessionId, time]` for each conversation the window notified the user about in the last day or would have notified them about if the conversation had not already been in front of them. Every window reads all of them. An item without `activity`, from an older version, is read from `state`: `prompt` is waiting, `unread` is stopped and `unseen`. An item without `steward` is a steward's when its title starts with the crown. When windows report one conversation differently, a report marked `here` wins over one that is not, since a list of the whole machine can be half a minute old; between reports both marked or both not, the one that needs the user most wins. When windows report one waiting conversation with different reasons, a `permission` with its `tool` or any other kind wins over a `permission` without one |
| When | A conversation that becomes `waiting`. A conversation that goes from `working` or `background` to `stopped` and `unseen`, once it has stayed that way for 5 seconds; one that turns up `stopped` and `unseen` with a `lastReplyAt` (or, without it, a `lastActiveAt`) newer than any this window read before for it counts too, as its turn ran between two reads. Not one that only becomes `unseen`, nor one that starts working again within those 5 seconds. An older window's `unread` is announced when it appears, after the 5 seconds. What a window reads in its first 10 seconds, and a conversation whose window went away and came back the same within two minutes, is not new. A notice says what the windows report when it is shown, not when the wait was first seen; if no window has reported the `tool` for a `permission` wait, the core waits for the tool name until 3 seconds after the wait was first seen |
| Who shows it | Only the window with the focus, after waiting 2 seconds for others that change with it, one notice for each conversation. The window skips the notice if it shows the conversation in front (`isFocused`), in any tab (`sessionForTab`) or where only its source can see it, such as a side bar (`shows`): the user is already looking at a conversation shown in front; for the others, the user is already in the window where they answer the conversation, and its tab dot and the count show that it needs attention. That holds for a reply left unread as for a wait. Each window's Conversations entry in the status bar counts waiting conversations except those shown in front in the focused window. It also counts conversations with plan questions as described under `questions`. A conversation in both groups counts once. Stopped `unseen` conversations are left to their notifications and not counted |
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

## Writing about a row

| Item | Rule |
| --- | --- |
| The pen | A pen button appears at the end of each Work plan row only while the source of the current conversation lists `'prefill'` in its `features`. Its tooltip is the command's title, in VS Code's display language. A click runs `agentPlus.writeAboutRow`, which is not in the command palette. Clicking a question row itself, rather than its pen, still opens its question in the Answer view |
| Text | `关于第 N 行（标题）：` when VS Code's display language is Chinese, and `About row N (title): ` for English and for every language the core has no strings for. N is the row's number as the view shows it, such as `2.1`. A title longer than 80 characters is cut to 79 and an ellipsis. `text` is at most 2,000 characters |
| `prefill(sessionId, text)` | The core calls this method on the source of the conversation whose plan is open in the Work plan view. If no tab or view in this window shows the conversation, the source opens it here as it would any other conversation. The source brings it to the front in this window and puts `text` in its message box without sending it. If the box already contains the user's text, the source appends `text`, inserting a space unless the existing text ends in white space. If the source cannot append, it returns `notReceived` and leaves the box unchanged. The box has the focus, with the cursor after `text` |
| Outcomes | `drafted`: `text` is in the box. `notReceived` with a `reason`: it is not, and nothing was changed. `uncertain`: the source put it there but could not tell whether it arrived. The source answers within 10 seconds and never rejects. The core treats a late answer as `uncertain`. If the source rejects, throws or returns an unknown outcome, the core treats the result as `notReceived`. |
| When it is not `drafted` | The core puts `text` on the clipboard and shows a notification: the `reason` for `notReceived`, or that it could not tell for `uncertain`. If the clipboard cannot be written, the notification gives `text` itself |
| Restricted Mode | No pen: as with answers, nothing is typed into a conversation there, and `prefill` is not called |

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
| `current` | `{ number, title, state, dim }` or `null`. The deepest `doing` row; plan order breaks ties. `null` when no row is `doing`: the bar then leaves that space empty (see Contents, left to right), and hovering over the bar lists the open rows. `dim`, which would draw the row in grey (see Contents, left to right), is always `false`; it is kept so that a bar written for an older core still reads the field. |
| `allDone` | `true` when no row is open and no row outside an archived subtree is in a state this version of the core does not know. This includes `total` of `0` when every row is archived or `dropped`. |
| `questions` | Number of rows waiting for the user's answer: rows in `waiting` or `discussing` with `waitingOn: user`. The Conversations entry in the status bar counts the running conversations in the Conversations view that have at least one such row for its `N conversations need you`, together with those waiting for the user (see Notifications, Who shows it). |
| `open` | Up to 30 counted rows that are not `done`, in plan order. Each is `{ number, title, state, depth }`, with `depth` of `1` for a top-level row, `2` for its children, and so on, and `asks: true` on a row waiting for the user's answer. |
| `asking` | `{ discussing, waiting }`: how many of the counted rows in each of those states wait for the user's answer. Together they make `questions`. |
| `asks` | Up to 30 of the rows waiting for the user's answer, in plan order. Each is `{ number, title, question }`; `question` is the row's question, or its title when it has none, cut to 200 characters. |

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
| `model()` | Returns what the bar last drew: whether it is in the compact form (`COMPACT_BELOW`), its bubbles, whether every row is done, the `to decide` text, the screen-reader label and the list each part shows on hover; `null` while the bar is hidden. |
| `destroy()` | Removes the bar and its hover list from the page. |
| Contents, left to right | A list icon and `Plan`; a bubble for each of `doing`, `waiting`, `discussing` and `todo` that has rows, in that order, each with that state's icon from the Work plan view and its number; a solid part with a question mark and `N to decide` when `questions` is above `0`, counting this conversation's questions only; an arrow. A row waiting for the user's answer counts in `N to decide` only, not in its state's bubble (`counts` minus `asking`), so the numbers add up to the open rows that are not parked. Parked and done rows get no bubble. If `allDone` is `true`, a green check with `All rows done` follows `Plan`. A summary without `asking`, from an older core, counts its asking rows in their states' bubbles too. |
| Colours | The bar reads the Work plan view's state icon colours from the page's `--vscode-*` variables: `charts.blue` for `doing`, `charts.orange` for `waiting`, `charts.yellow` for `discussing`, `charts.purple` for `todo`, `descriptionForeground` for `parked` and `charts.green` for done. A bubble draws its icon in its state's colour on a tint of that colour (`TINT`: 24% of it, 45% in light themes, whose orange and yellow are so close that lighter tints of them look the same). `to decide` is filled with `charts.orange`, the colour of the question mark the Work plan view gives a row waiting for the user's answer, with dark words; the light high contrast theme makes that colour a dark blue, where the words are white. |
| `COMPACT_BELOW` | The feature extensions use this exported constant of 400 CSS pixels. Below that width, the bar drops `Plan` and the arrow, and `to decide` keeps only its question mark and number; the bubbles stay. The compact bar returns to full size at `COMPACT_BELOW` plus `HYSTERESIS` (24 CSS pixels), so small width changes near the threshold do not switch it back and forth. |
| Layout | The bar fills the width of its containing element and stays on one line, 26 CSS pixels high. The bubbles and `to decide` are 18 CSS pixels high with equal-width digits; the space between the last bubble and `to decide` takes the rest of the width. |
| What it counts | In the fragment, `BUBBLES` sets which states get a bubble and in what order, and `WORD` names each state in the hover and the label. |
| Hover | After the pointer rests on the bar for 350 ms, a list shows above it. Over a bubble, it gives the number of that state's rows and lists them, without those waiting for the user's answer; over `to decide`, the number of questions and each question with its row's number; over the rest of the bar, the current row's whole title, the number of rows not done and the rows from `open`, each with its state icon and number, indented by depth. Each list shows up to `MAX_LIST` (30) rows, then `and N more`. Moving the pointer to another part while a list shows changes the list at once. |
| Clicks and keys | A click, `Enter`, or `Space` on the bar or a bubble calls `onOpen`. On `to decide`, the same actions call only `onAnswer`. |

### The commands

In Claude Code Plus and Codex Plus, `onOpen` runs `agentPlus.showWorkPlanOf` and `onAnswer` runs `agentPlus.answerQuestionOf`, each with the conversation's `{ sourceId, sessionId }`. Neither command appears in the command palette.

| Command | Does |
|---|---|
| `agentPlus.showWorkPlanOf` | Moves the Work plan view to the conversation, as a focus report does, and runs `agentPlus.workPlan.focus` to reveal the view. The next editor tab change moves the view as usual. |
| `agentPlus.answerQuestionOf` | Reads the plan as it is now and shows the first question in the Answer view, in the same plan order the Conversations view uses. The argument may also carry `row`, a row number such as `2.1`. If that row still has a question, the command shows it; otherwise it uses the first question in plan order. Clicking a question row in the Work plan view passes its number. This works even for a conversation the Conversations view leaves out, such as one outside the window's folders. If the source's last list omits the conversation, the core calls the source's `listConversations()` once more and waits up to 3 seconds (the same limit the Conversations view uses) before treating the conversation as not running. If there is no question, a message says so. The Answer view's Go to the conversation button opens the conversation through its source's `open()` when the source provides it. |

## Session list

> Draft, not implemented yet. Field names and limits may still change before the first version that ships it.

The session list is a webview view in an activity bar container of Agent Plus's own. It lists the conversations of this window's project from every registered source that lists `'sessions'`, together. The core keeps the list's own state for every source alike: groups, archived, pinned, title colours, the last reply the user saw, recently closed. A source lists its agent's conversations, says where else one is open, and carries out actions on them. A source with no `'sessions'` keeps its conversations out of the list and loses nothing else.

### What the source provides

| Member | Meaning |
| --- | --- |
| `features` | `'sessions'`: the source has `listSessions`, `onDidChangeSessions`, `sessionActions` and `runSessionAction`. `'sessionImport'`: it has `importSessions`. `'sessionSeen'`: it has `noteSeen`. `'sessionClose'`: it has `onDidCloseSession`. `'accountInfo'`: it has `accountInfo` and `onDidChangeAccountInfo`. `'sessionsNotice'`: it has `sessionsNotice` and `onDidChangeSessionsNotice` |
| `listSessions({ folders, cursor, limit })` | `Promise<{ sessions, cursor }>`: one page of this project's conversations, archived ones included, in any order. `folders` is the window's workspace folders as real paths, the first one first; the source lists the conversations it can open in this window from one of them, a folder below one, or a linked git worktree of one's repository (Claude Code only the first folder's, as it can open no other). `cursor` is `null` on the first call and the previous answer's `cursor` after it; an answer whose `cursor` is `null` or `''` is the last page. `limit` is the most the core wants in one answer. `sessions` is an array of Session (below) |
| `onDidChangeSessions` | `vscode.Event<void>`: a conversation came or went, or any field of one changed. The core reads the list again within a second of the last event; firing more often than needed is harmless |
| `sessionActions` | Frozen object, or a function returning one: what `runSessionAction` can do (Actions below). `{ open, create, rename, delete, own }`: `open` and `create` are arrays of the places it can open into, `'tab'` and `'sidebar'`; `rename` and `delete` are booleans; `own` is the source's own row actions, `[{ id, title }]`, drawn at the end of the row's menu |
| `runSessionAction(action, sessionIds, args)` | `Promise<{ results }>`: carries out `action` on each of `sessionIds` and answers `[{ sessionId, outcome, reason }]`, `outcome` being `'done'`, `'refused'` (the source would not, such as for a conversation open in another process) or `'failed'`; `reason` is a sentence for the user. Never rejects |
| `describeDeletion(sessionIds)` | `Promise<[{ sessionId, what }]>`: for each, one line saying what deleting it removes (its files, sub-agents, their size), for the confirmation |
| `wantSessionDetail(sessionIds)` | These rows are on screen and have `detail: false`: read what is missing, then fire `onDidChangeSessions` |
| `importSessions({ folders })` | With `'sessionImport'`. `Promise<{ archived, groups, pinned, colors }>`: what the agent's own list, or this source's own list, had for this project, read once when the list starts for a project. `archived` is `[{ sessionId, at }]`, `at` when it was archived if known; `groups` is `[{ name, sessionIds }]`; `pinned` is an array of ids; `colors` maps an id to a colour name (Title colours below). An answer of `null`, or none within 10 seconds, means the source cannot read them yet: the core asks again after the next `onDidChangeSessions`, and counts the source imported only once it has an answer. Groups are matched to the list's own by name |
| `noteSeen(sessionIds, seen)` | With `'sessionSeen'`. The list recorded these conversations as seen (`seen` true: the user had one in front, or marked it read) or marked them unread (`false`). A source whose agent keeps its own record of what was read writes it there, so that the agent's own interface agrees with the list |
| `onDidCloseSession` | With `'sessionClose'`. `vscode.Event<{ sessionId, where }>`, `where` being `'tab'` or `'sidebar'`: this window closed the conversation. Without it the core finds closed conversations itself, from `sessionForTab` and `shows`, and may not know where one was shown |
| `accountInfo({ sessionId })` | With `'accountInfo'`. Returns at once, not a Promise: `null`, or the source's part of the Account & usage section (below). The core takes a Promise as `null`. `sessionId` is this source's conversation in front in this window, or the one of it that was in front last while another agent's is, or `''` when none of it has been |
| `onDidChangeAccountInfo` | With `'accountInfo'`. `vscode.Event<void>` |
| `sessionsNotice()` | With `'sessionsNotice'`. Returns at once, not a Promise (the core takes one as `null`): `null`, or `{ text, actions }`: a note the core draws above the list with the source's logo, such as why it lists nothing (its agent is not installed). `text` is at most 300 characters; `actions` is at most 3 buttons, `[{ label, command, arguments }]`, each running `command` with `arguments` |
| `onDidChangeSessionsNotice` | With `'sessionsNotice'`. `vscode.Event<void>` |

### Session

| Field | Meaning |
| --- | --- |
| `sessionId` | As for Conversations |
| `title` | As for Conversations |
| `cwd` | The conversation's folder |
| `createdAt` | When it started, in epoch milliseconds |
| `lastActiveAt` | When it last had a message, in epoch milliseconds. Not a file's modification time, nor a time a rename or another change of its metadata moves: the list sorts by it and shows it |
| `lastReplyAt` | When the agent's last reply landed. A reply later than the newest time the user saw the conversation is unread |
| `lastUserAt` | When the user last wrote to it, as for Conversations. A plan question asked after it makes the conversation ask the user (the red dots) |
| `viewedAt` | Optional. When the agent's own interface last showed the conversation to the user, such as OpenCode's `time_viewed`; counts as seen |
| `unseen` | Optional. `true` when the agent's own interface holds the conversation as not read, such as a mark the user set there; the row then has the envelope until the source clears it, as when the user looks at the conversation in its agent; the core does not count it seen on its own account. `state` `unread` alone does not count here |
| `kind` | `'user'` (the default), `'background'` (a run nobody watches: `claude -p`, `claude --bg`, `codex exec`, `opencode run`), `'subagent'`, or `'empty'` (a conversation with no message yet). A source marks one `'background'` or `'subagent'` when it can tell; the list hides all but `'user'` while `agentPlus.sessions.hideBackground` is on |
| `parentId` | For a sub-agent or a background run, the conversation that started it, when known. Shown indented under it while background conversations are shown |
| `branch` | Its git branch, when known |
| `worktree` | The worktree's name when `cwd` is a git worktree of the project rather than one of the workspace folders |
| `activity`, `waitingFor`, `running` | As for Conversations. A stopped conversation may leave them out |
| `detail` | `false` while the source has not read the conversation's state: the row shows no dot and no envelope until it has (see `wantSessionDetail`). Defaults to `true` |
| `elsewhere` | Optional array of the other places where the conversation is open or runs: `[{ kind, label, detail, running }]`, `kind` being `'vscode'`, `'terminal'`, `'desktop'`, `'exec'` or `'other'`, `label` a few words ("terminal pts/3 in ~/proj"), `detail` lines for the hover (process id, folder, how it was started), `running` whether a turn runs there. The core finds the VS Code windows that write window entries itself (Open elsewhere); `'vscode'` is for one the source can tell is a VS Code window and the core cannot see, and the core drops it when it sees one |
| `processes` | Optional. How many processes have the conversation open, when the source can count them; more than one is drawn as a warning |
| `badges` | Optional array of the source's own marks after the title, `[{ text, tooltip, dim }]`, at most 2 |
| `actions` | Optional array of the `own` action ids (see `sessionActions`) that apply to this row now |
| `hover` | Optional array of extra lines for the row's hover, at most 6, such as what is still running after its turn |
| `steward` | As for Conversations |

### Actions

| `action` | `args` | The source |
| --- | --- | --- |
| `'open'` | `{ where }`, `'tab'` or `'sidebar'` | Opens the conversation in this window. The core never sends it for a conversation another VS Code window shows (it brings that window forward instead) or one `elsewhere` lists as open: two processes writing one conversation would lose turns |
| `'create'` | `{ where }` | Starts a new conversation; `sessionIds` is empty. Answers `[{ sessionId, outcome }]` with the new id: the source may wait for the new conversation to get its id before answering, within the 60 seconds. Without one it answers `''` with `'done'`, and the core takes the next new conversation of that source shown in this window as the one started |
| `'rename'` | `{ title }` | Gives it that title. The core does not send it for a conversation that runs in another process, which writes its old title back |
| `'delete'` | `{}` | Deletes it. The core sends only what its rules allow (Deleting below); the source checks again that nothing has it open and nothing runs, and refuses otherwise |
| an `own` id | `{}` | Whatever that action does |

- The core sends one action to one source at a time and waits for its answer before sending that source another. It gives up waiting after 60 seconds and shows the action as failed; a later answer is ignored.
- Restricted Mode: the core sends no action, and the list is read only.

### Account & usage

A collapsible section at the top of the list, with one part per source that gives `accountInfo()`. The part's head is the source's logo and label.

| Field of `accountInfo()` | Meaning |
| --- | --- |
| `rows` | `[{ label, value, tooltip }]`, at most 12: a label and its value on one line, such as the sign-in method or today's tokens |
| `bars` | `[{ label, percent, resetsAt, tooltip }]`, at most 4: a bar filled to `percent` (0 to 100), with when it resets in epoch milliseconds when known, such as a rate limit |
| `links` | `[{ label, command, arguments }]`, at most 3: links that run a command of the source's |
| `conversation` | Optional `{ title, rows }`: the figures of the conversation of this source in front, rows as above |

### Open elsewhere

A row is open elsewhere when another VS Code window on this machine shows the conversation, or its `elsewhere` lists a place. For the first, the core reads the window entries each source extension already writes, `<planDir()>/windows/<pid>.json` with the window's `name` and the `sessions` it shows (`shared/host/window-entries.js`), for every source with a `planDir`. A row open elsewhere is drawn dimmed with its dot as it is. Clicking it brings the other VS Code window forward; for a terminal or the desktop app, it opens nothing and the hover says where to close it first.

### Activity dots

The list and the core's other views draw one of five dots, or none, worked out from `activity`, `waitingFor`, `running` and the plan's questions:

| Dot | When |
| --- | --- |
| Blue, filled | `activity` is `'waiting'` with a `waitingFor` other than `planQuestion`: a dialog waits for the user (a permission, a choice, a question form, a plan to review). Wins over the others |
| Red, filled | The plan asks the user a question asked after the user's last message, and no turn runs and no background work runs |
| Red, ring | The same question, while a turn runs or background work runs |
| Green, filled | A turn runs |
| Green, ring | No turn runs, and background work does |
| None | Stopped, with no question |

"Needs you" counts blue and both reds. The core notifies for blue and filled red only.

### What the core does with them

- **Sections**: Account & usage, Recently closed (this window's, newest first, collapsed at first), the user's groups, Ungrouped, Archived. A conversation is listed once, except that one in Recently closed is also in its own section.
- **Order**: in each section the pinned conversations first, then the rest, each part by `lastActiveAt`, newest first.
- **Archived**: a mark the core keeps; the conversation moves out of its group, can still run and be opened, and stays archived when opened. Unarchiving puts it in Ungrouped. A source's own archive is not read or written after the import.
- **Archiving on its own**: a conversation inactive for `agentPlus.sessions.archiveAfterDays` days (14 by default) is archived, unless it is open in this window or elsewhere, runs or waits, is unread, is in a group, or is pinned.
- **Deleting**: only an archived conversation that is not pinned, that no window and no other process has open, and in which nothing runs. With `agentPlus.sessions.deleteArchived` on (the default), one archived for `agentPlus.sessions.deleteAfterDays` days (90 by default) is deleted, counting from the later of when the list first saw it archived and its `lastActiveAt`. Only one window on the machine archives and deletes on its own at a time.
- **Pinned**: kept in its section, first; never archived on its own; not deleted. Archiving a pinned conversation unpins it. One pinned and then archived by the agent's own interface stays pinned.
- **Unread**: the core records the newest `lastReplyAt` the user has seen of each conversation; `viewedAt` counts too, and so does the time the core's record of the project began, so that a first look does not show every old conversation as unread. A conversation counts as seen once it has been in front of the window for 1.5 seconds, so that a tab brought forward for a moment (as when restored tabs are loaded one after another) is not read. It tells a source with `'sessionSeen'` (`noteSeen`). A Session with `unseen` `true` is unread whatever the core recorded, until the source clears it. One marked unread while it is in front stays unread until another conversation comes to the front.
- **Restricted Mode**: the list still shows what the sources list, and changes nothing: no action goes to a source, nothing is archived or deleted on its own, the menus offer only opening and the read marks. A note above the list says so, with a Manage Workspace Trust button; it also says some agents start only in a trusted workspace, since an extension that does not start registers no source to explain itself.
- **A changed rule**: changing `agentPlus.sessions.archiveAfterDays`, `deleteArchived` or `deleteAfterDays` applies it at once, rather than at the next hourly pass.
- **Reopening**: Ctrl+Shift+T (Cmd+Shift+T) runs `agentPlus.reopenClosedConversation` while `agentPlus.lastClosedWasConversation` is set: the conversation of any source closed last in this window, at the place it was shown. A source whose agent binds the same key for its own conversations keeps that binding's condition off while `sessionListManages()` is `true`.

### What the core tells sources

| Member of the interface | Meaning |
| --- | --- |
| `features` | `'sessionList'` while the core has the session list |
| `sessionListManages()` | Whether the session list archives and deletes conversations on its own in this window now: `true` while it is on. A source with its own archiving or deleting on its own leaves it off while this is `true`, and asks again each time, so that turning the list off, or the core going, brings it back |
| `sessionDeletionDue(sourceId)` | A frozen object from session id to when the list will delete that conversation (epoch milliseconds), or `null` for one it will not delete (not archived, pinned, or deleting on its own off). For a source whose agent deletes old conversations by a rule of its own, such as Claude Code's `cleanupPeriodDays`, to keep them until then |
| `onDidChangeSessionDeletionDue` | `vscode.Event<{ sourceId }>` |

### Title colours

`red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` and `cyan`, the colours of Claude Code's `/color`, drawn in the theme's chart colours.

### Limits

| What | Limit |
| --- | --- |
| Sessions per source | 20000, over all pages; the core asks for 500 a page and stops at the limit |
| A page | Settles within 10 seconds, or the core keeps the source's previous list and tries again on the next change |
| `title` | 500 characters, cut |
| `elsewhere` | 8 places; `label` 80 characters, each `detail` line 200 |

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
- Sources should not type into conversations either (`canDeliver` false), and the Work plan view's rows have no pen.
- `deliver()` resolves to `notReceived` at once, `stewardOf()` returns `null` and `stewardsOf()` an empty array; `planPathOf()` answers as usual.

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
