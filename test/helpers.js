// Shared test utilities.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function tempDir(prefix = 'vrmd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Stands in for the Windows helper; records calls and returns canned answers.
class FakeHelper extends EventEmitter {
  constructor(answers = {}) {
    super();
    this.calls = [];
    this.answers = answers;
    this.status = 'ok';
    this.error = '';
  }

  start() {}
  stop() {}
  release() {}

  async call(op, args = {}) {
    this.calls.push({ op, ...args });
    const a = this.answers[op];
    if (typeof a === 'function') return a(args);
    if (a instanceof Error) throw a;
    return a === undefined ? true : a;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 2000, step = 10) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('waitFor timed out');
}

module.exports = { tempDir, FakeHelper, sleep, waitFor };
