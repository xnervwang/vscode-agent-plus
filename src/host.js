// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const sources = require('./sources');

const FAMILY = 'agent-work-plan';

/* The interface returned when start() threw: present, so a dependent extension can tell why it was not taken. */
function unavailable(error) {
  const why = 'Agent Work Plan could not start: ' + String((error && error.message) || error || 'unknown error');
  return Object.freeze({
    family: FAMILY, protocol: sources.PROTOCOL, accepts: sources.ACCEPTS.slice(), features: [],
    registerSource: () => ({ accepted: false, code: sources.REFUSED.failed, reason: why, registration: null }),
  });
}

function start(context, log) {
  void context; void log;
  return unavailable(new Error('not built yet'));
}

module.exports = { start, unavailable, FAMILY };
