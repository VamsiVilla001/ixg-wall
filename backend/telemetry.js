// System telemetry for the wall: CPU and memory from Node, network and GPU engine load from
// a long-running Windows counter agent. Emits one merged sample per interval.
// Hosted, the server isn't the machine showing the wall, so its numbers would mislead:
// samples then carry only a timestamp, a heartbeat that tells pages the backend is up.
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { assetPath } = require('./assets');

const AGENT_STALE_MS = 8000;

class Telemetry extends EventEmitter {
  constructor({ intervalMs = 2000, hosted = false, wallProfile = '' } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.hosted = hosted;
    this.wallProfile = wallProfile; // the managed wall window's browser profile: its memory is measured
    this.latest = null;
    this.agentSample = null;
    this.agent = null;
    this.agentRestarts = 0;
    this.prevCpu = null;
  }

  start() {
    this.prevCpu = cpuTimes();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (process.platform === 'win32' && !this.hosted) this.startAgent();
  }

  stop() {
    clearInterval(this.timer);
    this.stopping = true;
    this.agent?.kill();
  }

  startAgent() {
    let script;
    try {
      script = assetPath('telemetry/win-counters.ps1');
    } catch {
      return; // can't write the agent out; CPU and memory still come from Node
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', String(this.intervalMs)];
    if (this.wallProfile) args.push('-WallProfile', this.wallProfile);
    const agent = spawn('powershell', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.agent = agent;
    let buffer = '';
    agent.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.agentSample = { ...JSON.parse(line), receivedAt: Date.now() };
        } catch {
          // a partial or noisy line; the next one will do
        }
      }
    });
    agent.on('exit', () => {
      if (this.stopping) return;
      // Keep the agent alive, backing off if it keeps dying.
      const delay = Math.min(60000, 2000 * 2 ** this.agentRestarts++);
      setTimeout(() => this.startAgent(), delay);
    });
  }

  sample() {
    const now = Date.now();
    if (this.hosted) {
      this.latest = { t: now, agent: 'hosted' };
      this.emit('sample', this.latest);
      return;
    }
    const cur = cpuTimes();
    const busy = cur.busy - this.prevCpu.busy;
    const total = cur.total - this.prevCpu.total;
    this.prevCpu = cur;
    const a = this.agentSample && now - this.agentSample.receivedAt < AGENT_STALE_MS ? this.agentSample : null;
    this.latest = {
      t: now,
      cpu: total > 0 ? round1((busy / total) * 100) : null,
      cores: os.cpus().length,
      memUsedPct: round1((1 - os.freemem() / os.totalmem()) * 100),
      memTotalGB: round1(os.totalmem() / 1024 ** 3),
      rxMbps: a?.rxBps != null ? round1(a.rxBps / 1e6) : null,
      txMbps: a?.txBps != null ? round1(a.txBps / 1e6) : null,
      nic: a?.nic || null,
      videoEngine: a?.video ?? null,
      gpu3d: a?.gpu3d ?? null,
      // The managed wall window's memory: tab = the wall page and its players (renderers),
      // browser = every process of that browser. Null when the window isn't open.
      wallMem: a?.wall && Number.isFinite(a.wall.tabMB)
        ? { tabMB: a.wall.tabMB, browserMB: a.wall.browserMB, renderers: a.wall.renderers }
        : null,
      agent: process.platform !== 'win32' ? 'unsupported' : a ? 'ok' : 'starting',
    };
    this.emit('sample', this.latest);
  }
}

function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const { user, nice, sys, irq, idle } = c.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

const round1 = (v) => Math.round(v * 10) / 10;

module.exports = { Telemetry };
