'use strict';

// Runs one submitted bot. The parent forks this file with Node's permission
// model enabled (no file writes, no child processes) and a small heap, and the
// bot itself is evaluated in a fresh vm context that only holds plain
// JavaScript built-ins plus the ottv2 library. Only strings cross between this
// file and the context, so the bot never touches a host-realm object.

const vm = require('node:vm');

let context = null;
let output = null;

// Runs inside the bot's context before its code. Sets up console, require and
// module, and the hook the runner calls each turn.
const PRELUDE = `(function (global) {
  'use strict';
  const lib = global.OTT;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const out = [];
  const MAX_LINES = 20;

  function show(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value.toString === 'function' && value instanceof lib.Game) return value.toString();
    try { return stringify(value); } catch (_) { return String(value); }
  }
  function print() {
    if (out.length === MAX_LINES) out.push('… (more output this turn was dropped)');
    if (out.length > MAX_LINES) return;
    out.push(Array.prototype.map.call(arguments, show).join(' ').slice(0, 500));
  }
  global.console = { log: print, info: print, warn: print, error: print, debug: print };

  const module = { exports: {} };
  global.module = module;
  global.exports = module.exports;
  global.require = function (name) {
    if (name === 'ottv2' || name === './ottv2' || name === './ottv2.js') return lib;
    throw new Error("Only the 'ottv2' library is available, so require('" + name + "') does not work here");
  };

  function describe(value) {
    if (value === undefined) return 'nothing (undefined)';
    try { return stringify(value).slice(0, 120); } catch (_) { return String(value).slice(0, 120); }
  }

  global.__ottBind = function () {
    const exp = module.exports;
    let fn = null;
    if (typeof exp === 'function') fn = exp;
    else if (exp && typeof exp.move === 'function') fn = exp.move;
    else if (typeof move === 'function') fn = move;
    if (!fn) return false;

    global.__ottTurn = function (json, me) {
      const game = lib.Game.fromJSON(parse(json));
      game.me = me;
      const result = fn(game, lib);
      if (result && typeof result.then === 'function') {
        throw new Error('move() returned a Promise. Return the move directly instead of using async/await.');
      }
      const picked = lib.normalizeMove(result);
      return stringify(picked ? { move: picked } : { invalid: describe(result) });
    };
    return true;
  };

  return out;
})(globalThis)`;

function locate(stack) {
  const match = /bot\.js:(\d+):(\d+)/.exec(stack || '');
  return match ? ` (line ${match[1]}, column ${match[2]})` : '';
}

// Readable message for an error thrown by the bot, pointing at its own code.
function describeError(error) {
  if (!error || typeof error !== 'object') return String(error);
  if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'TIMEOUT';
  const name = error.name || 'Error';
  const message = error.message || String(error);
  if (name === 'SyntaxError') {
    // V8 puts "bot.js:LINE" and the offending source line at the top of the stack.
    const where = /^bot\.js:(\d+)/.exec(error.stack || '');
    return `SyntaxError: ${message}${where ? ` (line ${where[1]})` : ''}`;
  }
  return `${name}: ${message}${locate(error.stack)}`;
}

function drain() {
  return output ? Array.from(output.splice(0, output.length), String) : [];
}

function load({ code, library, timeLimit }) {
  context = vm.createContext(Object.create(null), {
    name: 'bot',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  new vm.Script(library, { filename: 'ottv2.js' }).runInContext(context);
  output = vm.runInContext(PRELUDE, context);
  try {
    new vm.Script(code, { filename: 'bot.js' }).runInContext(context, { timeout: timeLimit });
  } catch (error) {
    const message = describeError(error);
    return {
      ok: false,
      error: message === 'TIMEOUT' ? `Loading your code took longer than ${timeLimit} ms` : message,
      logs: drain(),
    };
  }
  if (vm.runInContext('__ottBind()', context) !== true) {
    return {
      ok: false,
      error: 'Your code has to define a function called move(game) that returns a move.',
      logs: drain(),
    };
  }
  return { ok: true, logs: drain() };
}

function turn({ state, me, timeLimit }) {
  const call = `__ottTurn(${JSON.stringify(JSON.stringify(state))}, ${me === 2 ? 2 : 1})`;
  const started = performance.now();
  let reply;
  try {
    reply = vm.runInContext(call, context, { timeout: timeLimit });
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const message = describeError(error);
    return {
      ok: false,
      error: message === 'TIMEOUT' ? `move() took longer than ${timeLimit} ms` : message,
      ms,
      logs: drain(),
    };
  }
  const ms = Math.round(performance.now() - started);
  let parsed = null;
  try {
    parsed = typeof reply === 'string' ? JSON.parse(reply) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'move() returned something unreadable', ms, logs: drain() };
  if (parsed.invalid !== undefined) {
    return { ok: false, error: `move() returned ${parsed.invalid}, which is not a move`, ms, logs: drain() };
  }
  return { ok: true, move: parsed.move, ms, logs: drain() };
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  let reply;
  try {
    if (message.type === 'load') reply = load(message);
    else if (message.type === 'turn' && context) reply = turn(message);
    else reply = { ok: false, error: `Unknown request: ${message.type}` };
  } catch (error) {
    reply = { ok: false, error: `Sandbox error: ${error && error.message}` };
  }
  process.send({ id: message.id, ...reply });
});

process.on('disconnect', () => process.exit(0));
