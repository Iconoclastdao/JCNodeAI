'use strict';

import { EventEmitter } from 'events';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';



import { EventEmitter } from 'events'
import os from 'os'

// ---------- Utilities ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

const uid = (() => {
  let i = 0
  return (prefix = '') => `${prefix}${Date.now().toString(36)}_${(i++).toString(36)}`
})()

async function runWithTimeout(promiseFn, ms = 5000, fallback = null) {
  if (typeof promiseFn !== 'function') throw new Error('promiseFn must be a function')
  let timed = false
  const timeout = new Promise((res) =>
    setTimeout(() => {
      timed = true
      res({ __timeout: true })
    }, ms),
  )
  try {
    const result = await Promise.race([promiseFn(), timeout])
    return timed ? fallback : result
  } catch (err) {
    throw new Error(`Task execution failed: ${err?.message || err}`)
  }
}

// ---------- Logger (single robust implementation) ----------
class Logger {
  constructor(level = 'info', context = '') {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 }
    this.levelName = level || 'info'
    this.level = this.levels[this.levelName] ?? this.levels.info
    this.context = context ? `[${context}]` : ''
  }

  _should(logLevel) {
    return this.level <= (this.levels[logLevel] ?? this.levels.info)
  }

  _out(levelTag, args) {
    const prefix = `[${levelTag.toUpperCase()}] ${this.context}`
    // Use console methods to preserve stack traces
    if (levelTag === 'error') console.error(prefix, ...args)
    else if (levelTag === 'warn') console.warn(prefix, ...args)
    else if (levelTag === 'debug') console.debug(prefix, ...args)
    else console.info(prefix, ...args)
  }

  debug(...args) {
    if (!this._should('debug')) return
    this._out('debug', args)
  }

  info(...args) {
    if (!this._should('info')) return
    this._out('info', args)
  }

  warn(...args) {
    if (!this._should('warn')) return
    this._out('warn', args)
  }

  error(...args) {
    if (!this._should('error')) return
    this._out('error', args)
  }
}

// ---------- CoreLoom: bounded concurrency orchestrator ----------
class CoreLoom extends EventEmitter {
  constructor({ concurrency = Math.max(2, (os.cpus()?.length || 4)), logger = new Logger('info', 'CoreLoom') } = {}) {
    super()
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer')
    this.concurrency = concurrency
    this.active = 0
    this.queue = []
    this.logger = logger
    this.tasks = new Map()
  }

  schedule(taskFn, priority = 0, timeoutMs = null) {
    if (typeof taskFn !== 'function') throw new Error('taskFn must be a function')
    const taskId = uid('task_')
    const item = { taskFn, resolve: null, reject: null, priority, id: taskId, timeoutMs }
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve
      item.reject = reject
      this.queue.push(item)
      // Highest priority first
      this.queue.sort((a, b) => b.priority - a.priority)
      this.logger.debug(`Scheduled task ${taskId} (priority=${priority})`)
      this._drain()
    })
    const cancel = () => this.cancel(taskId)
    return { id: taskId, promise, cancel }
  }

  cancel(taskId) {
    const idx = this.queue.findIndex((t) => t.id === taskId)
    if (idx !== -1) {
      const [task] = this.queue.splice(idx, 1)
      try { task.reject(new Error('Task cancelled')) } catch {}
      this.emit('taskCancelled', taskId)
      this.logger.info(`Cancelled ${taskId}`)
      return true
    }
    // If running, mark for cancellation (best-effort)
    if (this.tasks.has(taskId)) {
      this.logger.warn(`Requested cancel for running task ${taskId} (best-effort)`)
      return false
    }
    return false
  }

  async _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      this.active++
      this.tasks.set(task.id, task)
      this.emit('taskStart', task.id)
      this.logger.debug(`Starting task ${task.id} (active ${this.active})`)

      const runTask = async () => {
        try {
          let result
          if (task.timeoutMs) {
            result = await Promise.race([
              (async () => task.taskFn())(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Task timeout')), task.timeoutMs)),
            ])
          } else {
            result = await task.taskFn()
          }
          try { task.resolve(result) } catch {}
          this.emit('taskComplete', task.id, result)
        } catch (err) {
          try { task.reject(err) } catch {}
          this.emit('taskError', task.id, err)
        } finally {
          this.active--
          this.tasks.delete(task.id)
          // allow other tasks to proceed in next tick
          process.nextTick(() => this._drain())
        }
      }
      runTask()
    }
  }

  inspect() {
    return { active: this.active, queued: this.queue.length, running: this.tasks.size }
  }
}

// ---------- FractalOps: recursive emergent branching runner ----------
class FractalOps {
  static async run({
    taskFn,
    initialState = {},
    maxDepth = 4,
    loom = null,
    onResult = null,
    logger = new Logger('info', 'FractalOps'),
  } = {}) {
    if (typeof taskFn !== 'function') throw new Error('taskFn must be a function')
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative integer')
    loom = loom || new CoreLoom({ logger })
    const rootId = uid('fr_')
    logger.info(`Starting fractal run with rootId ${rootId}`)

    async function recurse(state, depth) {
      if (depth > maxDepth) {
        logger.warn(`Max depth ${maxDepth} exceeded at depth ${depth}`)
        return null
      }
      const out = await taskFn(state, depth)
      if (onResult) {
        try { await onResult({ state, depth, out }) } catch (e) { logger.error(`onResult failed: ${e?.message || e}`) }
      }
      const subtasks = Array.isArray(out?.subtasks) ? out.subtasks : []
      const results = [out?.result ?? null]
      if (depth < maxDepth && subtasks.length > 0) {
        const scheduled = subtasks.map((s) => loom.schedule(() => recurse(s, depth + 1), s.priority || 0))
        const subResults = await Promise.all(scheduled.map((p) => p.promise.catch(() => null)))
        results.push(...subResults.filter((r) => r !== null))
      }
      return results
    }

    return recurse(initialState, 0)
  }
}

// ---------- Foldstream: async generator folding ----------
const FOLDSTREAM_END = Symbol('FOLDSTREAM_END')
async function* Foldstream(initial, foldFn, logger = new Logger('info', 'Foldstream')) {
  if (typeof foldFn !== 'function') throw new Error('foldFn must be a function')
  let acc = initial
  logger.info('Starting Foldstream')
  while (true) {
    try {
      const next = yield acc
      if (next === FOLDSTREAM_END) {
        logger.info('Foldstream terminated')
        break
      }
      acc = await foldFn(acc, next)
      logger.debug('Foldstream updated accumulator')
    } catch (err) {
      logger.error(`Foldstream error: ${err?.message || err}`)
      throw err
    }
  }
  return acc
}

// ---------- Speculatrix & Speculacode ----------
class Speculatrix {
  constructor(scoringFn = null, logger = new Logger('info', 'Speculatrix')) {
    this.scoringFn = scoringFn || Speculatrix.defaultScorer
    this.logger = logger
  }

  async score(specTask) {
    if (!specTask || typeof specTask !== 'object') {
      this.logger.warn('Invalid specTask provided to score')
      return 0
    }
    try {
      const score = await this.scoringFn(specTask)
      this.logger.debug(`Scored specTask ${specTask.id || 'unknown'}: ${score}`)
      return score
    } catch (e) {
      this.logger.error(`Scoring failed: ${e?.message || e}`)
      return 0
    }
  }

  static async defaultScorer(specTask, probeMs = 200) {
    if (!specTask || !specTask.closure) return 0
    const probeFn = async () => {
      const r = specTask.closure()
      return r instanceof Promise ? await r : r
    }
    const probe = await runWithTimeout(probeFn, probeMs, null)
    if (probe === null || probe?.__timeout) return 0.1
    if (typeof probe === 'number') return Math.max(0, probe)
    if (typeof probe === 'object') return 1
    return 0.5
  }
}

class Speculacode {
  constructor({ speculatrix = null, logger = new Logger('info', 'Speculacode') } = {}) {
    this.specs = []
    this.speculatrix = speculatrix || new Speculatrix(null, logger)
    this.logger = logger
  }

  add(closure, meta = {}) {
    if (typeof closure !== 'function') throw new Error('closure must be a function')
    const id = uid('spec_')
    this.specs.push({ id, closure, meta })
    this.logger.info(`Added spec ${id}`)
    return id
  }

  list() {
    return this.specs.map((s) => ({ id: s.id, meta: s.meta }))
  }

  async collapseTopK(k = 1) {
    if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer')
    this.logger.info(`Collapsing top ${k} specs`)
    const scored = await Promise.all(
      this.specs.map(async (s) => ({ score: await this.speculatrix.score(s), s })),
    )
    scored.sort((a, b) => b.score - a.score)
    const chosen = scored.slice(0, Math.min(k, scored.length)).map((x) => x.s)
    const results = []
    for (const c of chosen) {
      try {
        const r = await Promise.resolve(c.closure())
        results.push(r)
        this.logger.debug(`Executed spec ${c.id}`)
      } catch (e) {
        results.push({ __error: e?.message || e })
        this.logger.error(`Spec ${c.id} execution failed: ${e?.message || e}`)
      }
    }
    // remove chosen specs
    this.specs = this.specs.filter((s) => !chosen.some((c) => c.id === s.id))
    return results
  }
}

// ---------- HyperCache: active intermediate memory store ----------
class HyperCache {
  constructor({ ttl = 3600 * 1000, logger = new Logger('info', 'HyperCache') } = {}) {
    this.map = new Map()
    this.ttl = ttl
    this.logger = logger
  }

  set(key, value, meta = {}) {
    this.map.set(key, { value, meta, ts: Date.now() })
    this.logger.debug(`Cache set: ${key}`)
  }

  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    if (Date.now() - e.ts > this.ttl) {
      this.map.delete(key)
      this.logger.debug(`Cache expired: ${key}`)
      return undefined
    }
    return e.value
  }

  has(key) {
    return this.get(key) !== undefined
  }

  delete(key) {
    this.logger.debug(`Cache delete: ${key}`)
    return this.map.delete(key)
  }

  keys() {
    return Array.from(this.map.keys())
  }

  entries() {
    return Array.from(this.map.entries()).map(([k, v]) => ({ k, v }))
  }

  clear() {
    this.map.clear()
    this.logger.info('Cache cleared')
  }

  echoSearch(token, matcher = (v) => JSON.stringify(v).includes(String(token))) {
    const out = []
    for (const [k, v] of this.map.entries()) {
      if (Date.now() - v.ts > this.ttl) {
        this.map.delete(k)
        continue
      }
      try {
        if (matcher(v.value)) out.push({ k, v })
      } catch {}
    }
    this.logger.debug(`Echo search for ${token}: ${out.length} results`)
    return out
  }
}

// ---------- OpshadowMesh: graph of latent closures ----------
class OpshadowNode {
  constructor(closure, meta = {}) {
    if (typeof closure !== 'function') throw new Error('closure must be a function')
    this.id = uid('op_')
    this.closure = closure
    this.meta = meta
    this.edges = new Set()
    this.state = 'latent'
    this.lastResult = undefined
  }

  addEdge(node) {
    this.edges.add(node.id ? node.id : node)
  }
}

class OpshadowMesh {
  constructor({ logger = new Logger('info', 'OpshadowMesh') } = {}) {
    this.nodes = new Map()
    this.logger = logger
  }

  addNode(closure, meta = {}) {
    const n = new OpshadowNode(closure, meta)
    this.nodes.set(n.id, n)
    this.logger.info(`Added opshadow node ${n.id}`)
    return n
  }

  link(a, b) {
    const na = a instanceof OpshadowNode ? a : this.nodes.get(a)
    const nb = b instanceof OpshadowNode ? b : this.nodes.get(b)
    if (!na || !nb) throw new Error('Invalid node link')
    na.addEdge(nb)
    this.logger.debug(`Linked nodes ${na.id} -> ${nb.id}`)
  }

  async evaluateNode(nodeId, probeMs = 200) {
    const node = this.nodes.get(nodeId)
    if (!node) {
      this.logger.warn(`Node ${nodeId} not found`)
      return null
    }
    const r = await runWithTimeout(() => Promise.resolve(node.closure()), probeMs, null)
    node.state = 'evaluated'
    node.lastResult = r
    this.logger.debug(`Evaluated node ${nodeId}: ${JSON.stringify(r)}`)
    return r
  }

  async collapse({ scorer = null, topK = 1, probeMs = 200 } = {}) {
    if (!Number.isInteger(topK) || topK < 1) throw new Error('topK must be a positive integer')
    scorer =
      scorer ||
      (async (node) => {
        const r = await runWithTimeout(() => Promise.resolve(node.closure()), probeMs, null)
        if (r === null) return 0
        if (typeof r === 'number') return r
        if (typeof r === 'object') return 1
        return 0.5
      })
    this.logger.info(`Collapsing opshadow mesh with topK=${topK}`)
    const scores = await Promise.all(
      Array.from(this.nodes.values()).map(async (node) => {
        try {
          return { node, sc: await scorer(node) }
        } catch (e) {
          this.logger.error(`Scoring node ${node.id} failed: ${e?.message || e}`)
          return { node, sc: 0 }
        }
      }),
    )
    scores.sort((a, b) => b.sc - a.sc)
    const chosen = scores.slice(0, topK).map((x) => x.node)
    const results = []
    for (const c of chosen) {
      try {
        const r = await Promise.resolve(c.closure())
        c.state = 'executed'
        c.lastResult = r
        results.push({ id: c.id, result: r })
        this.logger.debug(`Executed node ${c.id}`)
      } catch (e) {
        results.push({ id: c.id, error: e?.message || e })
        this.logger.error(`Node ${c.id} execution failed: ${e?.message || e}`)
      }
    }
    return results
  }
}

// ---------- MetaWeave (Emergent Execution Conductor) ----------
class MetaWeave extends EventEmitter {
  constructor(config = {}) {
    super()
    this.logger = config.logger || new Logger(config.logLevel || 'info', 'MetaWeave')
    this.loom = config.loom || new CoreLoom({ concurrency: config.concurrency || 4, logger: this.logger })
    this.fractal = config.fractal || FractalOps
    this.specula = config.specula || new Speculacode({ logger: this.logger })
    this.cache = config.cache || new HyperCache({ ttl: config.cacheTtl || 10 * 1000, logger: this.logger })
    this.mesh = config.mesh || new OpshadowMesh({ logger: this.logger })
  }

  async emergeloop(iterations = 3) {
    const outcomes = []
    for (let i = 0; i < iterations; i++) {
      const specResult = await (this.specula.executeWeighted ? this.specula.executeWeighted().catch(() => null) : Promise.resolve(null))
      // FractalOps.run is static; use it if provided
      const fractalResult = this.fractal?.run
        ? await this.fractal.run({ taskFn: async (s) => ({ result: s }), initialState: { id: uid('fractal_'), subtasks: [] }, logger: this.logger, loom: this.loom }).catch(() => null)
        : null
      const firstKey = [...this.mesh.nodes.keys()][0]
      const meshResult = firstKey ? await this.mesh.execute(firstKey).catch(() => null) : null
      const out = { specResult, fractalResult, meshResult }
      outcomes.push(out)
      this.emit('iteration', i, out)
      // small pause to avoid tight loop
      await sleep(0)
    }
    return outcomes
  }
}



async function runWithTimeout(promiseFn, ms = 5000, fallback = null) {
  if (typeof promiseFn !== 'function') throw new Error('promiseFn must be a function');
  let timed = false;
  let timer;
  const timeout = new Promise((res) => {
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

const generateNonce = () => crypto.randomBytes(16).toString('hex');

// ---------- Logger (Enhanced with Fallback) ----------
// TypeScript: interface LoggerOptions { level?: string; context?: string; logFile?: string }
class Logger {
  constructor({ level = 'info', context = '', logFile = path.join(__dirname, 'logs', `${context || 'app'}.log`) } = {}) {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.levelName = level.toLowerCase();
    this.level = this.levels[this.levelName] ?? this.levels.info;
    this.context = context ? `[${context}]` : '';
    this.logFile = logFile;
    this.fileEnabled = true;
    this._ensureLogDir().catch(() => { this.fileEnabled = false; });
  }

  async _ensureLogDir() {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
  }

  _should(logLevel) {
    return this.level <= (this.levels[logLevel] ?? this.levels.info);
  }

  async _out(levelTag, args) {
    const prefix = `[${new Date().toISOString()}][${levelTag.toUpperCase()}]${this.context}`;
    const message = `${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
    if (this.fileEnabled) {
      try {
        await fs.appendFile(this.logFile, message, { encoding: 'utf8' });
      } catch (e) {
        this.fileEnabled = false;
        console.warn(`[${new Date().toISOString()}][WARN][Logger] File logging failed, falling back to console: ${e.message}`);
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
  async error(...args) { await this._out('error', args); } // Always await errors
}

// ---------- CoreLoom: Bounded Concurrency Orchestrator ----------
// TypeScript: interface CoreLoomOptions { concurrency?: number; logger?: Logger }
class CoreLoom extends EventEmitter {
  constructor({ concurrency = Math.max(2, os.cpus()?.length || 4), logger = new Logger({ level: 'info', context: 'CoreLoom' }) } = {}) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.logger = logger;
    this.tasks = new Map();
    this.metrics = { completed: 0, failed: 0, cancelled: 0, avgLatency: 0 };
  }

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

  async _drain() {
    if (this.active >= this.concurrency || !this.queue.length) return;
    const task = this.queue.shift();
    this.active++;
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

  inspect() {
    return {
      active: this.active,
      queued: this.queue.length,
      running: this.tasks.size,
      metrics: { ...this.metrics }
    };
  }
}

// ---------- FractalOps: Recursive Branching Runner ----------
// TypeScript: interface FractalOpsOptions { taskFn: Function; initialState?: any; maxDepth?: number; loom?: CoreLoom; onResult?: Function; logger?: Logger; maxSubtasks?: number }
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

// ---------- Foldstream: Async Generator Folding ----------
const FOLDSTREAM_END = Symbol('FOLDSTREAM_END');
// TypeScript: type FoldFn<T> = (acc: T, next: any) => Promise<T>
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

// ---------- Speculatrix & Speculacode ----------
// TypeScript: interface SpecTask { id?: string; closure: Function; meta?: any }
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

// TypeScript: interface SpeculacodeOptions { speculatrix?: Speculatrix; logger?: Logger }
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

// ---------- HyperCache: Active Intermediate Memory Store ----------
// TypeScript: interface HyperCacheOptions { ttl?: number; logger?: Logger; maxSize?: number }
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

// ---------- OpshadowMesh: Graph of Latent Closures ----------
// TypeScript: interface OpshadowNodeOptions { closure: Function; meta?: any }
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

// TypeScript: interface OpshadowMeshOptions { logger?: Logger }
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

// ---------- LLM Modules (Stubbed for Transformers.js Integration) ----------
// TypeScript: interface LLMModule { compute(input: any, params?: any): Promise<any>; reverse(output: any): Promise<any>; mimicTransformation(input: any, refInput: any, refOutput: any): Promise<any> }
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

  getMetrics() { return { ...this.metrics, avgLatency: this.metrics.latency.reduce((a, b) => a + b, 0) / (this.metrics.latency.length || 1) }; }
}

class TokenizerModule extends LLMModule {
  constructor({ tokenizer = { encode: async t => Array.from(t).map(c => c.charCodeAt(0)), decode: async ids => String.fromCharCode(...ids) }, logger } = {}) {
    super({ logger });
    this.tokenizer = tokenizer; // Stub for transformers.js
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

class Superposed {
  constructor(options = [], { logger = new Logger({ level: 'info', context: 'Superposed' }) } = {}) {
    if (!Array.isArray(options) || !options.length) throw new Error('Superposed requires at least one option');
    this.options = options.map((o, i) => ({
      closure: o.closure,
      weight: o.weight ?? 1,
      meta: o.meta ?? { idx: i }
    }));
    this.state = 'superposed';
    this.result = null;
    this.logger = logger;
  }

  async collapse({ strategy = 'weighted', scorer = null } = {}) {
    if (this.state !== 'superposed') return this.result;

    let chosen;
    if (strategy === 'weighted') {
      const total = this.options.reduce((a, o) => a + o.weight, 0);
      let r = Math.random() * total;
      for (const opt of this.options) {
        if ((r -= opt.weight) <= 0) {
          chosen = opt;
          break;
        }
      }
    } else if (strategy === 'score' && scorer) {
      const scored = await Promise.all(this.options.map(async o => ({
        opt: o,
        score: await scorer(o)
      })));
      scored.sort((a, b) => b.score - a.score);
      chosen = scored[0].opt;
    } else {
      chosen = this.options[0];
    }

    try {
      this.result = await Promise.resolve(chosen.closure());
      this.state = 'collapsed';
      await this.logger.info('Superposition collapsed', {
        chosen: chosen.meta,
        result: this.result,
        discarded: this.options.filter(o => o !== chosen).map(o => o.meta)
      });
      return this.result;
    } catch (err) {
      this.state = 'collapsed';
      this.result = { error: err.message };
      await this.logger.error('Collapse execution failed', { error: err.message });
      return this.result;
    }
  }
}

class EmbedderModule extends LLMModule {
  constructor({ embedder = { embed: async ids => ids.map(x => x / 10) }, logger } = {}) {
    super({ logger });
    this.embedder = embedder; // Stub for transformers.js
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

// ---------- MetaWeave: Emergent Execution Conductor ----------
// TypeScript: interface MetaWeaveOptions { logger?: Logger; loom?: CoreLoom; fractal?: typeof FractalOps; specula?: Speculacode; cache?: HyperCache; mesh?: OpshadowMesh; maxIterations?: number }
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

class OllamaModule extends LLMModule {
  constructor({
    model = "llama2", // or "mistral", etc.
    apiUrl = "http://localhost:11434/api/generate",
    logger
  } = {}) {
    super({ logger });
    this.model = model;
    this.apiUrl = apiUrl;
  }

  async _compute(prompt, params = {}) {
    if (typeof prompt !== "string") throw new Error("Prompt must be a string");
    const body = {
      model: this.model,
      prompt,
      ...params
    };

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

  // Optionally implement reverse/mimicTransformation as needed
}

// ---------- Example Usage ----------
async function main() {

  const ollama = new OllamaModule({ model: "llama2", logger });

const prompt = "What is the capital of France?";
const ollamaResult = await ollama.compute(prompt);
await logger.info("Ollama result", ollamaResult);

// Or add to your pipeline:
const pipeline = [
  ['tokenize', tokenizer, {}],
  ['embed', embedder, {}],
  ['ollama', ollama, {}]
];
let result = "Hello, world!";
for (const [name, module, params] of pipeline) {
  result = await module.compute(result, params);
  await logger.info(`Pipeline step ${name}`, { result });
}

  const logger = new Logger({ level: 'debug', context: 'Main' });
  const loom = new CoreLoom({ concurrency: 2, logger });
  const cache = new HyperCache({ ttl: 5000, logger });
  const mesh = new OpshadowMesh({ logger });
  const specula = new Speculacode({ logger });
  const weave = new MetaWeave({ loom, cache, mesh, specula, logger });

  // Example LLM pipeline
  const tokenizer = new TokenizerModule({ logger });
  const embedder = new EmbedderModule({ logger });
  const pipeline = [
    ['tokenize', tokenizer, {}],
    ['embed', embedder, {}]
  ];
  const input = "Hello, world!";
  let result = input;
  for (const [name, module, params] of pipeline) {
    result = await module.compute(result, params);
    await logger.info(`Pipeline step ${name}`, { result });
  }

  // Example FractalOps
  const taskFn = async (state, depth) => ({
    result: { id: state.id, value: Math.random() },
    subtasks: depth < 2 ? [{ state: { id: uid('sub_') }, priority: 1 }] : []
  });
  const fractalResult = await FractalOps.run({ taskFn, initialState: { id: 'root' }, maxDepth: 2, loom, logger });
  await logger.info('FractalOps result', fractalResult);

  // Example Foldstream
  const fold = Foldstream(0, async (acc, next) => acc + (typeof next === 'number' ? next : 0), logger);
  await fold.next();
  await fold.next(5);
  await fold.next(10);
  const final = await fold.return(FOLDSTREAM_END);
  await logger.info('Foldstream final', { final });

  // Example Speculacode
  specula.add(() => ({ value: Math.random() }), { tag: 'rand1' });
  specula.add(() => ({ value: Math.random() * 2 }), { tag: 'rand2' });
  const specResults = await specula.collapseTopK(2);
  await logger.info('Speculacode results', specResults);

  // Example OpshadowMesh
  const n1 = mesh.addNode(() => ({ value: 1 }), { tag: 'node1' });
  const n2 = mesh.addNode(() => ({ value: 2 }), { tag: 'node2' });
  mesh.link(n1, n2);
  const meshResults = await mesh.collapse({ topK: 2 });
  await logger.info('OpshadowMesh results', meshResults);

  // Example MetaWeave
  const weaveResults = await weave.emergeloop({ iterations: 3 });
  await logger.info('MetaWeave results', weaveResults);

  await weave.saveState();
  await weave.loadState();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    const logger = new Logger({ level: 'error', context: 'Main' });
    await logger.error('Main execution failed', e);
    process.exit(1);
  });
}

export {
  Logger,
  CoreLoom,
  FractalOps,
  Speculatrix,
  Speculacode,
  HyperCache,
  OpshadowMesh,
  OpshadowNode,
  Foldstream,
  HyperCache as Cache,
  MetaWeave,
  FOLDSTREAM_END,
  runWithTimeout,
  uid,
  TokenizerModule,
  EmbedderModule
   OllamaModule
};

export default MetaWeave;
