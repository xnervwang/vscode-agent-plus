// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Simplified Chinese for the Conversations and Answer views (src/conversations-text.js has the English and what each
   entry is for). From src/l10n/conversations.zh-cn.js of vscode-claude-code-extras bb28f51. */
module.exports = {
  view: '对话',
  state: { prompt: '停在权限提示', needs: '要你定', working: '在跑', unread: '已回复未读', idle: '空闲' },
  questions: (n) => `${n} 个问题`,
  open: (n) => `${n} 项未完成`,
  noPlan: '没有工作计划',
  unknown: (n) => `${n} 行状态这个版本不认识`,
  unknownTip: (n) => `${n} 行的状态这个版本的 Agent Plus 不认识，没有算进任何计数。`,
  doing: (age) => (age ? `在做 ${age}` : '在做'),
  lastWorked: (age) => (age ? `在做（对话空闲 ${age}）` : '在做（对话空闲）'),
  asked: (age) => (age ? `${age}前问的` : '问过'),
  stopped: (n) => `已不在运行、计划未完成 (${n})`,
  folder: (cwd) => `文件夹：${cwd}`,
  status: (n) => `${n} 个要你定`,
  statusIdle: (n) => `对话 ${n}`,
  statusTip: '查看本工程的对话',
  badge: (n) => `${n} 个问题等你回答`,
  problem: '列不出正在运行的对话',
  answerEmpty: '点左边的一个问题，在这里回答。',
  answerRow: (row, title, ago) => `第 ${row} 行${title ? '：' + title : ''}${ago ? ` · ${ago}前问的` : ''}`,
  answerMore: '这一行的详情',
  answerPlaceholder: '你的回答。Ctrl+Enter 发给那个对话。',
  answerOpen: '去对话',
  answerSend: '发送',
  answerNotRunning: '没在运行。去那个对话里回答。',
  answerGone: '这一行已经不问这个了。去那个对话看它现在要什么。',
  answerRestricted: '受限模式：这个窗口不发送回答。信任这个工作区之后才能发。',
  answerState: (kind, time, reason) => ({
    waiting: '正在发送……',
    submitted: `${time} 已发出。`,
    drafted: `${time} 已放进那个对话的输入框，还没发出。到那边按回车发送。`,
    notReceived: reason === 'nobody'
      ? '没发：开着这个对话的 VS Code 窗口都没有接收。已复制到剪贴板。'
      : `没发${reason ? '：' + reason : ''}。已复制到剪贴板。`,
    uncertain: `${time} 已交出，但不知道对方收到没有。再发之前先去对话里看看；回答留在这里。`,
  }[kind] || '没发：没能交出去。已复制到剪贴板。'),
  answerMessage: (row, question, answer) => `第 ${row} 行的问题「${question}」，我的回答：\n${answer}`,
  briefSummary: '总结',
  briefStatus: '当前状态',
  briefDoing: '在做',
  briefProgress: '最新进展',
  briefNext: '下一步',
  briefWritten: (age) => `${age}前写的`,
  briefStale: '可能已过时：写完之后对话又跑过。',
  briefAuto: '这是自动拼的，不是对话自己写的。',
  briefLive: (state, rows) => `现在：${state}${rows ? ' · ' + rows : ''}`,
  briefQuestions: (n) => `在等你回答（${n}）`,
  briefNoRows: '工作计划里还没有行。',
  briefMoreRows: (n) => `还有 ${n} 行`,
  briefNothingDoing: '没有在做的行',
  briefLastActive: '最后活动',
  briefAgo: (age) => `${age}前`,
  briefUnknown: '不知道',
  briefGone: '这个对话已经不在列表里了。这是它最后一次在列表里时的样子。',
};
