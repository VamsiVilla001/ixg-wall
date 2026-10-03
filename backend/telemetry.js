// System telemetry for the wall: CPU and memory from Node, network and GPU engine load from
// a long-running Windows counter agent. Emits one merged sample per interval.
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { assetPath } = require('./assets');

const AGENT_STALE_MS = 8000;

class Telemetry extends EventEmitter {
  constructor({ intervalMs = 2000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.latest = null;
    this.agentSample = null;
    this.agent = null;
    this.agentRestarts = 0;
    this.prevCpu = null;
  }

  start() {
    this.prevCpu = cpuTimes();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (process.platform === 'win32') this.startAgent();
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
    const agent = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', String(this.intervalMs)], {
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
