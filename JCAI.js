'use strict';

// ----------- Imports -----------
import { EventEmitter } from 'events';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// For Node.js <18, uncomment the next line and run: npm install node-fetch
// import fetch from 'node-fetch';

// ----------- __dirname Polyfill -----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------- Utilities -----------
/** Sleep for ms milliseconds */
const sleep = ms => new Promise(res => setTimeout(res, ms));

/** Unique ID generator (prefix + timestamp + counter) */
const uid = (() => {
  let i = 0;
  return (prefix = '') => `${prefix}${Date.now().toString(36)}_${(i++).toString(36)}`;
})();

/** Generate a cryptographically secure nonce */
const generateNonce = () => crypto.randomBytes(16).toString('hex');

/**
 * Run a promise-returning function with a timeout.
 * @param {Function} promiseFn - Function returning a promise.
 * @param {number} ms - Timeout in ms.
 * @param {*} fallback - Value to return on timeout.
 */
async function runWithTimeout(promiseFn, ms = 5000, fallback = null) {
  if (typeof promiseFn !== 'function') throw new Error('promiseFn must be a function');
  let timed = false;
  let timer;
  const timeout = new Promise(res => {
    timer = setTimeout(() => {
      timed = true;
      res({ __timeout: true });
    }, ms);
  });
  try {
    const result = await Promise.race([promiseFn(), timeout]);
    clearTimeout(timer);
    return timed ? fallback : result;
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Task execution failed: ${err?.message || 'Unknown error'}`);
  }
}

// ----------- Logger -----------
/**
 * Logger with async file and console output.
 */
class Logger {
  /**
   * @param {Object} opts
   * @param {string} opts.level - Log level ('debug', 'info', 'warn', 'error')
   * @param {string} opts.context - Context string for logs
   * @param {string} opts.logFile - Log file path
   */
  constructor({ level = 'info', context = '', logFile = path.join(__dirname, 'logs', `${context || 'app'}.log`) } = {}) {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.levelName = level.toLowerCase();
    this.level = this.levels[this.levelName] ?? this.levels.info;
    this.context = context ? `[${context}]` : '';
    this.logFile = logFile;
    this.fileEnabled = true;
    this._ensureLogDir().catch(() => { this.fileEnabled = false; });
  }

  /** Ensure log directory exists */
  async _ensureLogDir() {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
  }

  /** Should log at this level? */
  _should(logLevel) {
    return this.level <= (this.levels[logLevel] ?? this.levels.info);
  }

  /** Output log to file and console */
  async _out(levelTag, args) {
    const prefix = `[${new Date().toISOString()}][${levelTag.toUpperCase()}]${this.context}`;
    const message = `${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ')}\n`;
    if (this.fileEnabled) {
      try {
        await fs.appendFile(this.logFile, message, { encoding: 'utf8' });
      } catch (e) {
        this.fileEnabled = false;
        console.warn(`[${new Date().toISOString()}][WARN][Logger] File logging failed: ${e.message}`);
      }
    }
    if (this._should(levelTag)) {
      const consoleMethod = { error: 'error', warn: 'warn', debug: 'debug' }[levelTag] || 'log';
      console[consoleMethod](prefix, ...args);
    }
  }

  async debug(...args) { if (this._should('debug')) await this._out('debug', args); }
  async info(...args) { if (this._should('info')) await this._out('info', args); }
  async warn(...args) { if (this._should('warn')) await this._out('warn', args); }
  async error(...args) { await this._out('error', args); }
}

// ----------- CoreLoom: Bounded Concurrency Orchestrator -----------
/**
 * Schedules and executes async tasks with bounded concurrency.
 */
class CoreLoom extends EventEmitter {
  constructor({ concurrency = Math.max(2, os.cpus()?.length || 4), logger = new Logger({ level: 'info', context: 'CoreLoom' }) } = {}) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.logger = logger;
    this.tasks = new Map();
    this.metrics = { completed: 0, failed: 0, cancelled: 0, avgLatency: 0, peakConcurrency: 0 };
  }

  /**
   * Schedule a task.
   * @param {Function} taskFn - Async function to run.
   * @param {number} priority - Higher runs first.
   * @param {number} timeoutMs - Optional timeout.
   * @param {Object} meta - Metadata.
   */
  schedule(taskFn, priority = 0, timeoutMs = null, meta = {}) {
    if (typeof taskFn !== 'function') throw new Error('taskFn must be a function');
    const taskId = uid('task_');
    const item = { taskFn, resolve: null, reject: null, priority, id: taskId, timeoutMs, meta, startTime: null };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      this.queue.push(item);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.logger.debug(`Scheduled task ${taskId}`, { priority, meta });
      this._drain();
    });
    return { id: taskId, promise, cancel: () => this.cancel(taskId) };
  }

  /** Cancel a queued task */
  cancel(taskId) {
    const idx = this.queue.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      const [task] = this.queue.splice(idx, 1);
      task.reject(new Error('Task cancelled'));
      this.metrics.cancelled++;
      this.emit('taskCancelled', taskId, task.meta);
      this.logger.info(`Cancelled task ${taskId}`);
      return true;
    }
    if (this.tasks.has(taskId)) {
      this.logger.warn(`Requested cancel for running task ${taskId} (best-effort)`);
      return false;
    }
    return false;
  }

  /** Internal: drain the queue and run tasks */
  async _drain() {
    if (this.active >= this.concurrency || !this.queue.length) return;
    const task = this.queue.shift();
    this.active++;
    this.metrics.peakConcurrency = Math.max(this.metrics.peakConcurrency, this.active);
    this.tasks.set(task.id, task);
    task.startTime = Date.now();
    this.emit('taskStart', task.id, task.meta);
    await this.logger.debug(`Starting task ${task.id}`, { active: this.active, meta: task.meta });

    const runTask = async () => {
      try {
        const result = task.timeoutMs
          ? await runWithTimeout(() => task.taskFn(), task.timeoutMs, null)
          : await task.taskFn();
        task.resolve(result);
        this.metrics.completed++;
        this.metrics.avgLatency = (this.metrics.avgLatency * (this.metrics.completed - 1) + (Date.now() - task.startTime)) / this.metrics.completed;
        this.emit('taskComplete', task.id, result, task.meta);
        await this.logger.info(`Completed task ${task.id}`, { meta: task.meta });
      } catch (err) {
        task.reject(err);
        this.metrics.failed++;
        this.emit('taskError', task.id, err, task.meta);
        await this.logger.error(`Task ${task.id} failed`, { error: err.message, meta: task.meta });
      } finally {
        this.active--;
        this.tasks.delete(task.id);
        process.nextTick(() => this._drain());
      }
    };
    runTask();
  }

  /** Inspect current state and metrics */
  inspect() {
    return {
      active: this.active,
      queued: this.queue.length,
      running: this.tasks.size,
      metrics: { ...this.metrics }
    };
  }
}

// ----------- FractalOps: Recursive Branching Runner -----------
/**
 * Recursively runs a branching async workflow.
 */
class FractalOps {
  static async run({
    taskFn,
    initialState = {},
    maxDepth = 4,
    loom = null,
    onResult = null,
    logger = new Logger({ level: 'info', context: 'FractalOps' }),
    maxSubtasks = 100
  } = {}) {
    if (typeof taskFn !== 'function') throw new Error('taskFn must be a function');
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative integer');
    if (!Number.isInteger(maxSubtasks) || maxSubtasks < 1) throw new Error('maxSubtasks must be a positive integer');
    loom = loom || new CoreLoom({ logger });
    const rootId = uid('fr_');
    await logger.info(`Starting fractal run`, { rootId, maxDepth });

    async function recurse(state, depth) {
      if (depth > maxDepth) {
        await logger.warn(`Max depth ${maxDepth} exceeded`, { depth });
        return null;
      }
      const out = await taskFn(state, depth);
      if (onResult) {
        try { await onResult({ state, depth, out }); } catch (e) { await logger.error(`onResult failed`, { error: e.message }); }
      }
      const subtasks = Array.isArray(out?.subtasks) ? out.subtasks.slice(0, maxSubtasks) : [];
      const results = [out?.result ?? null];
      if (depth < maxDepth && subtasks.length) {
        const scheduled = subtasks.map(s => loom.schedule(() => recurse(s.state || s, depth + 1), s.priority || 0, s.timeoutMs));
        const subResults = await Promise.all(scheduled.map(p => p.promise.catch(() => null)));
        results.push(...subResults.filter(r => r !== null));
      }
      return results;
    }

    const results = await recurse(initialState, 0);
    await logger.info(`Fractal run completed`, { rootId, resultCount: results.length });
    return results;
  }
}

// ----------- Foldstream: Async Generator Folding -----------
const FOLDSTREAM_END = Symbol('FOLDSTREAM_END');
/**
 * Async generator that folds values into an accumulator.
 */
async function* Foldstream(initial, foldFn, logger = new Logger({ level: 'info', context: 'Foldstream' })) {
  if (typeof foldFn !== 'function') throw new Error('foldFn must be a function');
  let acc = initial;
  await logger.info('Starting Foldstream', { initial });
  while (true) {
    try {
      const next = yield acc;
      if (next === FOLDSTREAM_END) {
        await logger.info('Foldstream terminated');
        break;
      }
      acc = await foldFn(acc, next);
      await logger.debug('Foldstream updated accumulator', { acc });
    } catch (err) {
      await logger.error(`Foldstream error`, { error: err.message });
      throw err;
    }
  }
  return acc;
}

// ----------- Speculatrix & Speculacode -----------
/**
 * Scores speculative tasks.
 */
class Speculatrix {
  constructor({ scoringFn = null, logger = new Logger({ level: 'info', context: 'Speculatrix' }) } = {}) {
    this.scoringFn = scoringFn || Speculatrix.defaultScorer;
    this.logger = logger;
  }

  async score(specTask) {
    if (!specTask || typeof specTask !== 'object') {
      await this.logger.warn('Invalid specTask provided to score');
      return 0;
    }
    try {
      const score = await this.scoringFn(specTask);
      await this.logger.debug(`Scored specTask`, { id: specTask.id || 'unknown', score });
      return score;
    } catch (e) {
      await this.logger.error(`Scoring failed`, { error: e.message });
      return 0;
    }
  }

  static async defaultScorer(specTask, probeMs = 200) {
    if (!specTask?.closure) return 0;
    const probeFn = () => Promise.resolve(specTask.closure());
    const probe = await runWithTimeout(probeFn, probeMs, null);
    if (probe === null || probe?.__timeout) return 0.1;
    if (typeof probe === 'number') return Math.max(0, probe);
    if (typeof probe === 'object') return 1;
    return 0.5;
  }
}

/**
 * Manages speculative code closures.
 */
class Speculacode {
  constructor({ speculatrix = null, logger = new Logger({ level: 'info', context: 'Speculacode' }) } = {}) {
    this.specs = new Map();
    this.speculatrix = speculatrix || new Speculatrix({ logger });
    this.logger = logger;
  }

  add(closure, meta = {}) {
    if (typeof closure !== 'function') throw new Error('closure must be a function');
    const id = uid('spec_');
    this.specs.set(id, { id, closure, meta });
    this.logger.info(`Added spec`, { id, meta });
    return id;
  }

  list() {
    return Array.from(this.specs.values()).map(s => ({ id: s.id, meta: s.meta }));
  }

  async collapseTopK(k = 1) {
    if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
    await this.logger.info(`Collapsing top ${k} specs`);
    const scored = await Promise.all(
      Array.from(this.specs.values()).map(async s => ({ score: await this.speculatrix.score(s), s }))
    );
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, Math.min(k, scored.length)).map(x => x.s);
    const results = [];
    for (const c of chosen) {
      try {
        const r = await Promise.resolve(c.closure());
        results.push({ id: c.id, result: r });
        await this.logger.debug(`Executed spec`, { id: c.id });
      } catch (e) {
        results.push({ id: c.id, error: e.message });
        await this.logger.error(`Spec execution failed`, { id: c.id, error: e.message });
      }
      this.specs.delete(c.id);
    }
    return results;
  }
}

// ----------- HyperCache: Active Intermediate Memory Store -----------
/**
 * Simple TTL cache with logging.
 */
class HyperCache {
  constructor({ ttl = 3600 * 1000, logger = new Logger({ level: 'info', context: 'HyperCache' }), maxSize = 10000 } = {}) {
    this.map = new Map();
    this.ttl = ttl;
    this.logger = logger;
    this.maxSize = maxSize;
  }

  set(key, value, meta = {}) {
    if (this.map.size >= this.maxSize) {
      const oldest = Array.from(this.map.entries()).sort((a, b) => a[1].ts - b[1].ts)[0][0];
      this.map.delete(oldest);
      this.logger.debug(`Evicted oldest cache entry`, { key: oldest });
    }
    this.map.set(key, { value, meta, ts: Date.now() });
    this.logger.debug(`Cache set`, { key, meta });
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttl) {
      this.map.delete(key);
      this.logger.debug(`Cache expired`, { key });
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this.logger.debug(`Cache delete`, { key });
    return this.map.delete(key);
  }

  keys() {
    return Array.from(this.map.keys());
  }

  entries() {
    return Array.from(this.map.entries()).map(([k, v]) => ({ key: k, value: v.value, meta: v.meta, ts: v.ts }));
  }

  clear() {
    this.map.clear();
    this.logger.info('Cache cleared');
  }

  echoSearch(token, matcher = (v) => JSON.stringify(v).includes(String(token))) {
    const out = [];
    for (const [k, v] of this.map.entries()) {
      if (Date.now() - v.ts > this.ttl) {
        this.map.delete(k);
        continue;
      }
      try {
        if (matcher(v.value)) out.push({ key: k, value: v.value, meta: v.meta });
      } catch {}
    }
    this.logger.debug(`Echo search`, { token, results: out.length });
    return out;
  }
}

// ----------- OpshadowMesh: Graph of Latent Closures -----------
/**
 * Node in the OpshadowMesh graph.
 */
class OpshadowNode {
  constructor(closure, meta = {}) {
    if (typeof closure !== 'function') throw new Error('closure must be a function');
    this.id = uid('op_');
    this.closure = closure;
    this.meta = meta;
    this.edges = new Set();
    this.state = 'latent';
    this.lastResult = undefined;
    this.lastEvaluated = null;
  }

  addEdge(node) {
    this.edges.add(node.id ? node.id : node);
  }
}

/**
 * Graph of closures for speculative execution.
 */
class OpshadowMesh {
  constructor({ logger = new Logger({ level: 'info', context: 'OpshadowMesh' }) } = {}) {
    this.nodes = new Map();
    this.logger = logger;
  }

  addNode(closure, meta = {}) {
    const node = new OpshadowNode(closure, meta);
    this.nodes.set(node.id, node);
    this.logger.info(`Added opshadow node`, { id: node.id, meta });
    return node;
  }

  link(a, b) {
    const na = a instanceof OpshadowNode ? a : this.nodes.get(a);
    const nb = b instanceof OpshadowNode ? b : this.nodes.get(b);
    if (!na || !nb) throw new Error('Invalid node link');
    na.addEdge(nb);
    this.logger.debug(`Linked nodes`, { from: na.id, to: nb.id });
  }

  async evaluateNode(nodeId, probeMs = 200) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      await this.logger.warn(`Node not found`, { nodeId });
      return null;
    }
    const result = await runWithTimeout(() => Promise.resolve(node.closure()), probeMs, null);
    node.state = 'evaluated';
    node.lastResult = result;
    node.lastEvaluated = Date.now();
    await this.logger.debug(`Evaluated node`, { nodeId, result });
    return result;
  }

  async collapse({ scorer = null, topK = 1, probeMs = 200 } = {}) {
    if (!Number.isInteger(topK) || topK < 1) throw new Error('topK must be a positive integer');
    scorer = scorer || (async (node) => {
      const r = await runWithTimeout(() => Promise.resolve(node.closure()), probeMs, null);
      if (r === null) return 0;
      if (typeof r === 'number') return r;
      if (typeof r === 'object') return 1;
      return 0.5;
    });
    await this.logger.info(`Collapsing opshadow mesh`, { topK });
    const scores = await Promise.all(
      Array.from(this.nodes.values()).map(async node => {
        try {
          return { node, score: await scorer(node) };
        } catch (e) {
          await this.logger.error(`Scoring node failed`, { id: node.id, error: e.message });
          return { node, score: 0 };
        }
      })
    );
    scores.sort((a, b) => b.score - a.score);
    const chosen = scores.slice(0, topK).map(x => x.node);
    const results = [];
    for (const c of chosen) {
      try {
        const r = await Promise.resolve(c.closure());
        c.state = 'executed';
        c.lastResult = r;
        c.lastEvaluated = Date.now();
        results.push({ id: c.id, result: r });
        await this.logger.debug(`Executed node`, { id: c.id });
      } catch (e) {
        results.push({ id: c.id, error: e.message });
        await this.logger.error(`Node execution failed`, { id: c.id, error: e.message });
      }
    }
    return results;
  }

  topoSort() {
    if (!this.nodes.size) return [];
    const indegree = new Map();
    const queue = [];
    const order = [];
    for (const id of this.nodes.keys()) {
      indegree.set(id, 0);
    }
    for (const node of this.nodes.values()) {
      for (const edge of node.edges) {
        indegree.set(edge, (indegree.get(edge) || 0) + 1);
      }
    }
    for (const [id, deg] of indegree) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      const node = this.nodes.get(id);
      for (const edge of node.edges) {
        indegree.set(edge, indegree.get(edge) - 1);
        if (indegree.get(edge) === 0) queue.push(edge);
      }
    }
    if (order.length !== this.nodes.size) throw new Error('Graph contains cycles');
    return order;
  }
}

// ----------- LLMModule and OllamaModule -----------
/**
 * Abstract base for LLM modules.
 */
class LLMModule {
  constructor({ logger = new Logger({ level: 'info', context: 'LLMModule' }) } = {}) {
    this.logger = logger;
    this.rateLimit = { maxPerSec: 100, last: 0 };
    this.metrics = { calls: 0, errors: 0, latency: [] };
  }

  async throttle() {
    const now = Date.now();
    const minGap = 1000 / this.rateLimit.maxPerSec;
    const delta = now - this.rateLimit.last;
    if (delta < minGap) await sleep(minGap - delta);
    this.rateLimit.last = now;
  }

  async compute(input, params = {}) {
    await this.throttle();
    this.metrics.calls++;
    const start = Date.now();
    try {
      const result = await this._compute(input, params);
      this.metrics.latency.push(Date.now() - start);
      await this.logger.info('compute', { input, params });
      return result;
    } catch (e) {
      this.metrics.errors++;
      await this.logger.error('compute', { error: e.message });
      throw e;
    }
  }

  async _compute(_input, _params) { throw new Error(`${this.constructor.name}._compute not implemented`); }

  async reverse(output) {
    await this.throttle();
    this.metrics.calls++;
    const start = Date.now();
    try {
      const result = await this._reverse(output);
      this.metrics.latency.push(Date.now() - start);
      await this.logger.info('reverse', { output });
      return result;
    } catch (e) {
      this.metrics.errors++;
      await this.logger.error('reverse', { error: e.message });
      throw e;
    }
  }

  async _reverse(_output) { throw new Error(`${this.constructor.name}._reverse not implemented`); }

  async mimicTransformation(input, refInput, refOutput) {
    await this.throttle();
    this.metrics.calls++;
    const start = Date.now();
    try {
      const result = await this._mimicTransformation(input, refInput, refOutput);
      this.metrics.latency.push(Date.now() - start);
      await this.logger.info('mimic', { input, refInput });
      return result;
    } catch (e) {
      this.metrics.errors++;
      await this.logger.error('mimic', { error: e.message });
      throw e;
    }
  }

  async _mimicTransformation(_input, _refInput, _refOutput) { throw new Error(`${this.constructor.name}._mimicTransformation not implemented`); }

  getMetrics() {
    return {
      ...this.metrics,
      avgLatency: this.metrics.latency.reduce((a, b) => a + b, 0) / (this.metrics.latency.length || 1)
    };
  }
}

/**
 * Tokenizer stub module.
 */
class TokenizerModule extends LLMModule {
  constructor({ tokenizer = { encode: async t => Array.from(t).map(c => c.charCodeAt(0)), decode: async ids => String.fromCharCode(...ids) }, logger } = {}) {
    super({ logger });
    this.tokenizer = tokenizer;
  }

  async _compute(inputText, _params) {
    if (typeof inputText !== 'string') throw new Error('Input must be a string');
    const tokens = await this.tokenizer.encode(inputText);
    return { input_ids: tokens, length: inputText.length };
  }

  async _reverse(output) {
    if (!output?.input_ids) throw new Error('Invalid output for reverse tokenize');
    const text = await this.tokenizer.decode(output.input_ids);
    return { text, input_ids: output.input_ids };
  }

  async _mimicTransformation(input, refInput, refOutput) {
    if (typeof input !== 'string') throw new Error('Input must be a string');
    let adjusted = input;
    if (refInput && typeof refInput === 'string') {
      adjusted = input.length > refInput.length ? input.slice(0, refInput.length) : input.padEnd(refInput.length, ' ');
    }
    return this.compute(adjusted);
  }
}

/**
 * Embedder stub module.
 */
class EmbedderModule extends LLMModule {
  constructor({ embedder = { embed: async ids => ids.map(x => x / 10) }, logger } = {}) {
    super({ logger });
    this.embedder = embedder;
  }

  async _compute(tokens, _params) {
    if (!tokens?.input_ids) throw new Error('Invalid tokens input');
    const embeddings = await this.embedder.embed(tokens.input_ids);
    return { embeddings, input_ids: tokens.input_ids };
  }

  async _reverse(output) {
    if (!output?.embeddings) throw new Error('Invalid output for reverse embed');
    return { input_ids: output.input_ids || [], embeddings: output.embeddings };
  }

  async _mimicTransformation(input, _refInput, _refOutput) {
    return this.compute(input);
  }
}

/**
 * Ollama LLM integration module.
 */
class OllamaModule extends LLMModule {
  constructor({
    model = "llama2",
    apiUrl = "http://localhost:11434/api/generate",
    logger
  } = {}) {
    super({ logger });
    this.model = model;
    this.apiUrl = apiUrl;
  }

  async _compute(prompt, params = {}) {
    if (typeof prompt !== "string") throw new Error("Prompt must be a string");
    const body = { model: this.model, prompt, ...params };
    // Use fetch (Node 18+ or node-fetch polyfill)
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error: ${res.status} ${text}`);
    }
    // Ollama streams responses, but for simplicity, collect all output
    let output = "";
    if (res.body && res.body.getReader) {
      // Node.js 18+ ReadableStream
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += Buffer.from(value).toString();
      }
      // Ollama streams JSON lines, so parse them
      const lines = output.split("\n").filter(Boolean);
      const texts = lines.map(line => {
        try {
          const obj = JSON.parse(line);
          return obj.response || "";
        } catch {
          return "";
        }
      });
      return { text: texts.join(""), model: this.model };
    } else {
      // Fallback: just get text
      const json = await res.json();
      return { text: json.response || "", model: this.model };
    }
  }
}

// ----------- MetaWeave: Emergent Execution Conductor -----------
/**
 * Orchestrates all modules and workflows.
 */
class MetaWeave extends EventEmitter {
  constructor({
    logger = new Logger({ level: 'info', context: 'MetaWeave' }),
    loom = new CoreLoom({ logger }),
    fractal = FractalOps,
    specula = new Speculacode({ logger }),
    cache = new HyperCache({ logger }),
    mesh = new OpshadowMesh({ logger }),
    maxIterations = 10
  } = {}) {
    super();
    this.logger = logger;
    this.loom = loom;
    this.fractal = fractal;
    this.specula = specula;
    this.cache = cache;
    this.mesh = mesh;
    this.maxIterations = maxIterations;
    this.state = 'idle';
  }

  /**
   * Run the emergent loop for a number of iterations.
   */
  async emergeloop({ iterations = this.maxIterations, context = {} } = {}) {
    if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
    this.state = 'running';
    const outcomes = [];
    for (let i = 0; i < iterations; i++) {
      if (this.state === 'stopped') break;
      await this.logger.info(`Starting iteration ${i + 1}/${iterations}`, { context });
      const iterationId = uid('iter_');
      const specResult = await this.specula.collapseTopK(1).catch(e => {
        this.logger.error(`Speculacode failed`, { error: e.message });
        return null;
      });
      const fractalResult = await this.fractal.run({
        taskFn: async (s, d) => ({ result: s, subtasks: d < 2 ? [{ state: { id: uid('sub_') } }] : [] }),
        initialState: { id: uid('fractal_'), ...context },
        logger: this.logger,
        loom: this.loom
      }).catch(e => {
        this.logger.error(`FractalOps failed`, { error: e.message });
        return null;
      });
      const meshOrder = this.mesh.nodes.size ? this.mesh.topoSort() : [];
      const meshResult = await Promise.all(
        meshOrder.map(id => this.mesh.evaluateNode(id, 200).catch(() => null))
      ).then(results => results.filter(r => r !== null));
      const outcome = { iterationId, specResult, fractalResult, meshResult };
      this.cache.set(iterationId, outcome, { iteration: i });
      outcomes.push(outcome);
      this.emit('iteration', i, outcome);
      await sleep(1);
    }
    this.state = 'idle';
    await this.logger.info(`Emergeloop completed`, { outcomeCount: outcomes.length });
    return outcomes;
  }

  stop() {
    this.state = 'stopped';
    this.logger.info('Emergeloop stopped');
  }

  async saveState(filename = path.join(__dirname, 'metaweave_state.json')) {
    const state = {
      cache: this.cache.entries(),
      mesh: Array.from(this.mesh.nodes.values()).map(n => ({
        id: n.id,
        meta: n.meta,
        edges: Array.from(n.edges),
        state: n.state,
        lastResult: n.lastResult,
        lastEvaluated: n.lastEvaluated
      })),
      metrics: this.loom.inspect().metrics
    };
    await fs.writeFile(filename, JSON.stringify(state, null, 2));
    await this.logger.info(`State saved`, { filename });
  }

  async loadState(filename = path.join(__dirname, 'metaweave_state.json')) {
    try {
      const data = JSON.parse(await fs.readFile(filename, 'utf8'));
      this.cache.clear();
      data.cache.forEach(({ key, value, meta, ts }) => this.cache.set(key, value, { ...meta, ts }));
      this.mesh.nodes.clear();
      data.mesh.forEach(({ id, meta, edges, state, lastResult, lastEvaluated }) => {
        const node = new OpshadowNode(() => lastResult, meta);
        node.id = id;
        node.state = state;
        node.lastResult = lastResult;
        node.lastEvaluated = lastEvaluated;
        node.edges = new Set(edges);
        this.mesh.nodes.set(id, node);
      });
      await this.logger.info(`State loaded`, { filename });
    } catch (e) {
      await this.logger.error(`Failed to load state`, { error: e.message });
      throw e;
    }
  }
}

// ----------- Exports -----------
export {
  Logger,
  CoreLoom,
  FractalOps,
  Speculatrix,
  Speculacode,
  HyperCache,
  OpshadowNode,
  OpshadowMesh,
  Foldstream,
  HyperCache as Cache,
  MetaWeave,
  FOLDSTREAM_END,
  runWithTimeout,
  uid,
  generateNonce,
  TokenizerModule,
  EmbedderModule,
  OllamaModule
};
export default MetaWeave;
Usage Example
import { Logger, MetaWeave, OllamaModule, TokenizerModule, EmbedderModule } from './yourfile.mjs';

const logger = new Logger({ level: 'debug', context: 'Main' });
const ollama = new OllamaModule({ model: "llama2", logger });
const tokenizer = new TokenizerModule({ logger });
const embedder = new EmbedderModule({ logger });

const pipeline = [
  ['tokenize', tokenizer, {}],
  ['embed', embedder, {}],
  ['ollama', ollama, {}]
];

let result = "What is the capital of France?";
for (const [name, module, params] of pipeline) {
  result = await module.compute(result, params);
  await logger.info(`Pipeline step ${name}`, { result });
}
