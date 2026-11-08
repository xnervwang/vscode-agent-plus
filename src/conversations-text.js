// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Interface strings for the Conversations view, the Answer view and the status bar entry, by language. Row titles and
 * questions are shown as the conversation wrote them, and so are a work plan's state names (`doing`, `todo`), which the
 * user and the agents use as they are. From src/conversations-text.js of vscode-claude-code-extras bb28f51.
 */
const TEXT = {
  en: {
    view: 'Conversations',
    state: { prompt: 'at a permission prompt', needs: 'needs you', working: 'working', unread: 'replied, not read', idle: 'idle' },
    questions: (n) => (n === 1 ? '1 question' : `${n} questions`),
    open: (n) => `${n} open`,
    noPlan: 'no work plan',
    unknown: (n) => `${n} in a state this version does not know`,
    unknownTip: (n) => `${n} row${n === 1 ? ' is' : 's are'} in a state this version of Agent Work Plan does not know, and counted nowhere.`,
    doing: (age) => (age ? `doing for ${age}` : 'doing'),
    lastWorked: (age) => (age ? `doing (conversation idle ${age})` : 'doing (conversation idle)'),
    asked: (age) => (age ? `asked ${age} ago` : 'asked'),
    stopped: (n) => `Not running, with open rows (${n})`,
    folder: (cwd) => `Folder: ${cwd}`,
    status: (n) => (n === 1 ? '1 to decide' : `${n} to decide`),
    statusIdle: (n) => `Conversations ${n}`,
    statusTip: 'Show the conversations of this workspace',
    badge: (n) => (n === 1 ? '1 question for you' : `${n} questions for you`),
    problem: 'Could not list the running conversations',
    answerEmpty: 'Click a question on the left to answer it here.',
    answerRow: (row, title, ago) => `Row ${row}${title ? ': ' + title : ''}${ago ? ` · asked ${ago} ago` : ''}`,
    answerMore: 'Row details',
    answerPlaceholder: 'Your answer. Ctrl+Enter sends it to the conversation.',
    answerOpen: 'Go to the conversation',
    answerSend: 'Send',
    answerNotRunning: 'Not running. Open the conversation to answer it.',
    answerGone: 'This row is no longer asking this. Look at the conversation to see what it needs now.',
    answerRestricted: 'Restricted Mode: this window does not send answers. Trust the workspace to send one.',
    answerState: (kind, time, reason) => ({
      waiting: 'Sending...',
      submitted: `Sent at ${time}.`,
      drafted: `Put in the conversation's input box at ${time}, not sent. Press Enter there to send it.`,
      notReceived: reason === 'nobody'
        ? 'Not sent: no VS Code window with this conversation open took it. Copied to the clipboard.'
        : `Not sent${reason ? ': ' + reason : ''}. Copied to the clipboard.`,
      uncertain: `Handed over at ${time}, and whether it arrived is not known. Look in the conversation before sending it again; `
        + 'the answer is kept here.',
    }[kind] || 'Not sent: it could not be handed over. Copied to the clipboard.'),
    answerMessage: (row, question, answer) => `My answer to row ${row} ("${question}"):\n${answer}`,
  },
  'zh-cn': require('./l10n/conversations.zh-cn'),
};

const LANGUAGES = Object.keys(TEXT);

/** zh-cn when VS Code runs in Simplified Chinese, en otherwise. */
function language(editor) {
  return /^zh(-cn|-hans|-sg)?$/i.test(String(editor || '')) ? 'zh-cn' : 'en';
}

/* Chinese, Japanese and Korean script, written as escapes because shipped source files contain only English. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** zh-cn for text with CJK characters, en otherwise. */
const languageOf = (text) => (CJK.test(String(text || '')) ? 'zh-cn' : 'en');

const textFor = (lang) => TEXT[lang] || TEXT.en;

module.exports = { TEXT, LANGUAGES, language, languageOf, textFor };
