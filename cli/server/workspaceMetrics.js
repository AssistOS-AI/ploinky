import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { collectAgentRuntimeStatesAsync } from '../sandbox/agentRuntimeState.js';
import { getRuntime } from '../sandbox/docker/common.js';
import { aggregateProcessTreeMetrics } from './workspaceProcessMetrics.js';

const RECONCILE_INTERVAL_MS = 5_000;
const SAMPLE_INTERVAL_MS = 2_000;
const execFileAsync = promisify(execFile);

function parsePercent(value) {
  const parsed = Number.parseFloat(String(value || '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBytes(value) {
  const raw = String(value || '').split('/')[0].trim();
  const match = raw.match(/^([\d.]+)\s*([kmgt]?i?b)?$/i);
  if (!match) return 0;
  const factors = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };
  return Number(match[1]) * (factors[String(match[2] || 'b').toLowerCase()] || 1);
}

async function collectHostMetrics(states) {
  const pids = states
    .filter((entry) => entry.state?.running && entry.state.pid)
    .map((entry) => Number(entry.state.pid));
  if (!pids.length) return new Map();
  let stdout = '';
  try {
    ({ stdout = '' } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss='], { encoding: 'utf8' }));
  } catch (_) {
    return new Map();
  }
  return aggregateProcessTreeMetrics(stdout, pids);
}

function publicRuntimeEntry(entry, metrics) {
  return {
    containerName: String(entry?.containerName || ''),
    agentName: String(entry?.agentName || '-'),
    repoName: String(entry?.repoName || '-'),
    runtime: String(entry?.runtime || 'container'),
    enabled: Boolean(entry?.enabled),
    state: {
      status: String(entry?.state?.status || 'unknown'),
      running: Boolean(entry?.state?.running),
    },
    metrics,
  };
}

class WorkspaceMetricsMonitor extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.states = [];
    this.containerMetrics = new Map();
    this.statsProcess = null;
    this.activeContainerKey = '';
    this.statsUnsupportedKey = '';
    this.routerCpu = null;
    this.hostMetrics = new Map();
    this.latest = null;
    this.reconcileInFlight = false;
    this.sampleInFlight = false;
    void this.reconcile();
    this.sampleTimer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.sampleTimer.unref?.();
    this.reconcileTimer.unref?.();
  }

  runningContainerNames() {
    return this.states
      .filter((entry) => !['bwrap', 'seatbelt'].includes(entry.runtime) && entry.state?.running)
      .map((entry) => entry.containerName)
      .filter(Boolean)
      .sort();
  }

  async reconcile() {
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    try {
      this.states = await collectAgentRuntimeStatesAsync();
    } catch (_) {
      this.publish();
      return;
    } finally {
      this.reconcileInFlight = false;
    }
    const names = this.runningContainerNames();
    const key = names.join('\0');
    if (key !== this.activeContainerKey) this.statsUnsupportedKey = '';
    if (this.statsUnsupportedKey !== key && (key !== this.activeContainerKey || (!this.statsProcess && names.length))) {
      this.startContainerStats(names);
    }
    this.publish();
  }

  async sample() {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      this.hostMetrics = await collectHostMetrics(this.states);
      this.publish();
    } finally {
      this.sampleInFlight = false;
    }
  }

  startContainerStats(names) {
    if (this.statsProcess) {
      try { this.statsProcess.kill('SIGTERM'); } catch (_) {}
    }
    this.statsProcess = null;
    this.activeContainerKey = names.join('\0');
    this.containerMetrics = new Map();
    if (!names.length) {
      this.statsUnsupportedKey = '';
      return;
    }
    let runtime;
    try { runtime = getRuntime(); } catch (_) { return; }
    const child = spawn(runtime, ['stats', '--format', '{{json .}}', ...names], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.statsProcess = child;
    let buffer = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          const name = String(value.Name || value.Container || value.ID || '').trim();
          if (!name) continue;
          this.containerMetrics.set(name, {
            available: true,
            cpuPercent: parsePercent(value.CPUPerc || value.CPU),
            memoryBytes: parseBytes(value.MemUsage || value.Mem),
          });
        } catch (_) {}
      }
    });
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString('utf8')}`.slice(-16 * 1024);
    });
    child.on('error', () => {
      if (this.statsProcess === child) {
        this.statsProcess = null;
        this.activeContainerKey = '';
      }
    });
    child.on('close', () => {
      if (this.statsProcess === child) {
        this.statsProcess = null;
        if (/did not create a cgroup|does not have a cgroup/i.test(errorOutput)) {
          this.statsUnsupportedKey = this.activeContainerKey;
        } else {
          this.activeContainerKey = '';
        }
      }
    });
  }

  routerMetrics() {
    const usage = process.cpuUsage();
    const now = process.hrtime.bigint();
    let cpuPercent = 0;
    if (this.routerCpu) {
      const elapsedMicros = Number(now - this.routerCpu.time) / 1_000;
      const usedMicros = (usage.user - this.routerCpu.usage.user) + (usage.system - this.routerCpu.usage.system);
      cpuPercent = elapsedMicros > 0 ? (usedMicros / elapsedMicros) * 100 : 0;
    }
    this.routerCpu = { usage, time: now };
    return { available: true, cpuPercent, memoryBytes: process.memoryUsage().rss };
  }

  publish() {
    const routerMetrics = this.routerMetrics();
    const unavailable = { available: false, cpuPercent: 0, memoryBytes: 0 };
    const runtimes = this.states.map((entry) => {
      let metrics = unavailable;
      if (!['bwrap', 'seatbelt'].includes(entry.runtime) && entry.state?.running) {
        metrics = this.containerMetrics.get(entry.containerName)
          || this.hostMetrics.get(Number(entry.state.pid))
          || unavailable;
      }
      if (['bwrap', 'seatbelt'].includes(entry.runtime) && entry.state?.running) metrics = this.hostMetrics.get(Number(entry.state.pid)) || unavailable;
      return publicRuntimeEntry(entry, metrics);
    });
    const total = runtimes.reduce((sum, entry) => ({
      cpuPercent: sum.cpuPercent + (entry.metrics.available ? entry.metrics.cpuPercent : 0),
      memoryBytes: sum.memoryBytes + (entry.metrics.available ? entry.metrics.memoryBytes : 0),
    }), { cpuPercent: routerMetrics.cpuPercent, memoryBytes: routerMetrics.memoryBytes });
    this.latest = {
      ok: true,
      sampledAt: new Date().toISOString(),
      router: { status: 'running', pid: process.pid, metrics: routerMetrics },
      runtimes,
      total,
    };
    this.emit('snapshot', this.latest);
  }

  subscribe(listener) {
    const safeListener = (snapshot) => {
      try { listener(snapshot); } catch (_) {}
    };
    this.on('snapshot', safeListener);
    if (this.latest) safeListener(this.latest);
    return () => this.off('snapshot', safeListener);
  }
}

export const workspaceMetricsMonitor = new WorkspaceMetricsMonitor();
