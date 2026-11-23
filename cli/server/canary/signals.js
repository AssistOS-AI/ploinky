import { randomUUID } from 'node:crypto';
import { outcomeFields, SignalCounts } from './counters.js';
import { scheduleProbes } from './probeScheduler.js';
import { DEFAULT_THRESHOLDS, excessErrors, excessLatency, rolloutThresholds } from './tripRules.js';

const DAY_MS = 24 * 60 * 60_000;

function checkShare(share) {
    if (!Number.isFinite(share) || share < 0 || share > 100) throw new RangeError('invalid canary share');
}

// Versions are opaque on the wire. A fresh Router cannot reissue a version
// previously read for the same rollout, even after a restart in the same ms.
export class CanarySignals {
    #rollouts = new Map();
    #baselines = new Map();
    #probe;
    #oldConnections = new Map();

    constructor({ now = Date.now, log = () => {}, probe } = {}) {
        this.now = now;
        this.log = log;
        this.#probe = probe;
    }

    #baseline(routeKey) {
        let baseline = this.#baselines.get(routeKey);
        if (!baseline) {
            baseline = new SignalCounts(DEFAULT_THRESHOLDS.slowMs);
            this.#baselines.set(routeKey, baseline);
        }
        return baseline;
    }

    #match(routeKey, rolloutId) {
        const r = this.#rollouts.get(routeKey);
        return r && r.rolloutId === rolloutId ? r : undefined;
    }

    #incident(r) {
        r.lastIncidentAt = this.now();
        r.exposureVersion = `${r.epoch}:${++r.revision}`;
        r.seal = null;
    }

    #log(r, type, reason) {
        this.log(type, { routeKey: r.routeKey, rolloutId: r.rolloutId, state: r.state,
            reason, exposureVersion: r.exposureVersion });
    }

    #state(r, state, reason) {
        if (r.state === state) return;
        r.state = state;
        this.#log(r, 'canary_state_change', reason);
        const copy = state === 'all' ? 'old' : ['removed', 'withdrawn', 'tripped', 'paused', 'prepare-rejected'].includes(state) ? 'canary' : null;
        if (copy) {
            for (const close of r.connections[copy]) {
                r.connections[copy].delete(close);
                try { close(); } catch { /* Keep closing the other streams. */ }
            }
        }
    }

    #trip(r, reason) {
        this.#incident(r);
        r.lastTripReason = reason;
        if (r.state === 'split') this.#state(r, 'tripped', reason);
        this.#log(r, 'canary_trip', reason);
    }

    // A continuing condition is one trip. A subsequent independent incident
    // still invalidates exposure and is reported while paused or tripped.
    #rule(r, reason, firing) {
        if (!firing) r.firing.delete(reason);
        else if (!r.firing.has(reason)) {
            r.firing.add(reason);
            this.#trip(r, reason);
        }
    }

    #attachProbe(r) {
        r.stopProbe?.();
        if (this.#probe) {
            r.stopProbe = scheduleProbes({ probe: this.#probe, target: r.target,
                observe: result => this.recordProbe(r.routeKey, r.rolloutId, result) });
        }
    }

    // S2 supplies the exact-container operation once it is available.
    setProbe(probe) {
        if (probe != null && typeof probe !== 'function') throw new TypeError('expected canary probe function');
        this.#probe = probe;
        for (const r of this.#rollouts.values()) this.#attachProbe(r);
    }

    #open(config, state) {
        const { routeKey, rolloutId, commit, share, containerId, startedAt, container, probe } = config;
        if (!routeKey || !rolloutId || this.#rollouts.has(routeKey)) {
            throw new Error('canary rollout requires a new route and a rollout id');
        }
        checkShare(share);
        const thresholds = rolloutThresholds(config.thresholds);
        const now = this.now();
        const old = new SignalCounts(thresholds.slowMs);
        const baseline = this.#baselines.get(routeKey);
        if (baseline) old.seedWindow(baseline, now);
        const publishedStart = typeof config.splitStartedAt === 'number'
            ? config.splitStartedAt : Date.parse(config.splitStartedAt);
        const splitStartedAt = Number.isFinite(publishedStart) ? publishedStart : now;
        const epoch = randomUUID();
        const r = {
            routeKey, rolloutId, commit, share, thresholds, old, canary: new SignalCounts(thresholds.slowMs),
            connections: { old: this.#oldConnections.get(routeKey) || new Set(), canary: new Set() },
            target: Object.freeze({ routeKey, rolloutId, container, containerId, ...(config.runtime ? { runtime: config.runtime } : {}), probe: probe && Object.freeze({ ...probe }) }),
            containerId, startedAt, running: undefined,
            splitStartedAt, lastIncidentAt: now, lastTripReason: null, firing: new Set(),
            consecutiveConnections: 0, consecutiveProbes: 0, seal: null,
            epoch, revision: 0, exposureVersion: `${epoch}:0`,
        };
        this.#rollouts.set(routeKey, r);
        if (state === 'paused') this.#incident(r);
        this.#state(r, state, state === 'split' ? 'rollout-start' : 'router-start');
        this.#attachProbe(r);
        return r;
    }

    startRollout(config) {
        this.#open(config, 'split');
    }

    // Read the committed generation on boot. An unaccepted 'all' has no
    // receipt proof in S4 and must also wait for explicit recovery.
    routerStarted(routes, { onlyMissing = false } = {}) {
        for (const [routeKey, route] of Object.entries(routes)) {
            const config = route?.canary;
            if (!config) continue;
            const state = ['retiring', 'withdrawn'].includes(config.mode) ? config.mode : 'paused';
            const r = this.#match(routeKey, config.rolloutId);
            if (r) {
                if (onlyMissing) continue;
                this.#incident(r);
                this.#state(r, state, 'router-start');
            } else {
                this.#open({ ...config, routeKey }, state);
            }
        }
    }

    routingState(routeKey, rolloutId) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return null;
        this.#advanceWindow(r, this.now());
        return { state: r.state, exposureVersion: r.exposureVersion, running: r.running };
    }

    trackConnection(routeKey, rolloutId, copy, close, selectedVersionIsCurrent = true) {
        const r = this.#match(routeKey, rolloutId);
        const current = this.#rollouts.get(routeKey);
        if ((copy === 'canary' && (!r || r.state === 'withdrawn'
            || (!selectedVersionIsCurrent && ['paused', 'tripped'].includes(r.state))))
            || (copy === 'old' && current?.state === 'all')) {
            close();
            return () => {};
        }
        const connections = copy === 'old'
            ? current?.connections.old || this.#oldConnections.get(routeKey) || new Set() : r.connections.canary;
        if (copy === 'old') this.#oldConnections.set(routeKey, connections);
        connections.add(close);
        return () => {
            connections.delete(close);
            if (connections.size === 0 && this.#oldConnections.get(routeKey) === connections) this.#oldConnections.delete(routeKey);
        };
    }

    replaceProbeTarget(routeKey, rolloutId, { runtime, containerId }) {
        const r = this.#match(routeKey, rolloutId);
        if (!r || r.target.containerId === containerId) return;
        this.recordProbe(routeKey, rolloutId, { ok: false, containerId });
        r.target = Object.freeze({ ...r.target, runtime, containerId });
        this.#attachProbe(r);
    }

    publishedMode(routeKey, rolloutId, mode) {
        const r = this.#match(routeKey, rolloutId);
        if (r) this.#state(r, mode, 'published-mode');
    }

    removeRollout(routeKey, rolloutId) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return false;
        r.stopProbe?.();
        this.#state(r, 'removed', 'rollout-removed');
        if (!r.connections.old.size) this.#oldConnections.delete(routeKey);
        this.#rollouts.delete(routeKey);
        return true;
    }

    setShare(routeKey, rolloutId, share) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return false;
        checkShare(share);
        if (r.share !== share) {
            r.share = share;
            this.settingsChanged(routeKey, rolloutId);
        }
        return true;
    }

    settingsChanged(routeKey, rolloutId) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return false;
        this.#incident(r);
        r.splitStartedAt = this.now();
        return true;
    }

    resume(routeKey, rolloutId) {
        const r = this.#match(routeKey, rolloutId);
        if (!r || r.running === false || !['tripped', 'paused'].includes(r.state)) return false;
        const now = this.now();
        this.#advanceWindow(r, now);
        r.splitStartedAt = now;
        r.consecutiveConnections = 0;
        r.consecutiveProbes = 0;
        r.firing.delete('unreachable');
        r.firing.delete('probe-failures');
        this.#state(r, 'split', 'resume');
        return true;
    }

    recordOutcome({ routeKey, copy = 'old', rolloutId, status = 0, serverError = false,
        unreachable = false, callerError = false, timingOnly = false, ttfbMs }) {
        if (!routeKey || (copy !== 'old' && copy !== 'canary')) return;
        const r = this.#rollouts.get(routeKey);
        if ((copy === 'canary' || rolloutId != null) && (!r || r.rolloutId !== rolloutId)) return;
        const now = this.now();
        const fields = timingOnly ? [] : callerError ? ['callerErrors'] : outcomeFields({ status, serverError, unreachable });
        const timing = !callerError && Number.isFinite(ttfbMs) && ttfbMs >= 0 ? ttfbMs : undefined;
        if (copy === 'old') this.#baseline(routeKey).record(now, fields, timing);
        if (!r) return;
        this.#advanceWindow(r, now);
        r[copy].record(now, fields, timing);
        if (copy === 'canary' && !callerError) {
            // Resume acknowledges the original trip. Only new adverse evidence
            // can retrigger the same ongoing breach after that acknowledgement.
            if (r.state === 'split') {
                if (fields.includes('backendFailures')) r.firing.delete('server-errors');
                if (timing > r.thresholds.slowMs) r.firing.delete('slow');
            }
            if (!timingOnly) {
                r.consecutiveConnections = unreachable ? r.consecutiveConnections + 1 : 0;
                this.#rule(r, 'unreachable', r.consecutiveConnections >= r.thresholds.consecutiveConnections);
            }
        }
        this.#evaluateWindow(r, now);
    }

    // A quiet route may cross a threshold at one expiry and recover at the
    // next. Replay each distinct boundary before discarding the evidence.
    #advanceWindow(r, now) {
        while (true) {
            const expiry = Math.min(r.old.nextExpiry(), r.canary.nextExpiry());
            if (expiry > now) return;
            this.#evaluateWindow(r, expiry);
        }
    }

    #evaluateWindow(r, now) {
        const canary = r.canary.current(now);
        const old = r.old.current(now);
        this.#rule(r, 'server-errors', excessErrors(canary, old, r.thresholds));
        this.#rule(r, 'slow', excessLatency(canary, old, r.thresholds));
    }

    recordProbe(routeKey, rolloutId, result) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return;
        const { ok, running, containerId, startedAt, inspectFailed } = result ?? {};
        const failed = ok !== true || running === false || inspectFailed === true;
        const restarted = Boolean((containerId && r.containerId && containerId !== r.containerId)
            || (startedAt != null && r.startedAt != null && startedAt !== r.startedAt));
        const exited = running === false && r.running !== false;
        const fields = ['probes'];
        if (failed) fields.push('probeFailures');
        if (inspectFailed) fields.push('inspectFailures');
        if (restarted) fields.push('restarts');
        if (exited) fields.push('exits');
        const now = this.now();
        this.#advanceWindow(r, now);
        r.canary.record(now, fields);
        if (containerId) r.containerId = containerId;
        if (startedAt != null) r.startedAt = startedAt;
        if (typeof running === 'boolean') r.running = running;
        else if (!failed) r.running = true;
        if (restarted) this.#trip(r, 'container-restart');
        if (exited) this.#trip(r, 'container-exit');
        r.consecutiveProbes = failed ? r.consecutiveProbes + 1 : 0;
        this.#rule(r, 'probe-failures', r.consecutiveProbes >= r.thresholds.consecutiveProbes);
    }

    // An old comparison sample can expire while the route is quiet. Sweep
    // idle routes, and check again at each status read and promotion fence.
    refresh() {
        const now = this.now();
        for (const baseline of this.#baselines.values()) baseline.current(now);
        for (const r of this.#rollouts.values()) this.#advanceWindow(r, now);
    }

    #promotable(r, now) {
        return r.state === 'split' && !r.firing.size && r.share >= 10
            && now - Math.max(r.lastIncidentAt, r.splitStartedAt) >= DAY_MS;
    }

    seal(routeKey, rolloutId, version) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return false;
        const now = this.now();
        this.#advanceWindow(r, now);
        if (r.exposureVersion !== version || !this.#promotable(r, now)) return false;
        r.seal = version;
        return true;
    }

    acceptsSeal(routeKey, rolloutId, version) {
        const r = this.#match(routeKey, rolloutId);
        if (!r) return false;
        this.#advanceWindow(r, this.now());
        return r.state === 'split' && r.seal === version && r.exposureVersion === version;
    }

    status() {
        const now = this.now();
        const rollouts = Array.from(this.#rollouts.values(), r => {
            this.#advanceWindow(r, now);
            const counts = { old: r.old.snapshot(now), canary: r.canary.snapshot(now) };
            return {
                routeKey: r.routeKey, rolloutId: r.rolloutId, commit: r.commit, state: r.state, share: r.share,
                splitStartedAt: new Date(r.splitStartedAt).toISOString(), exposureVersion: r.exposureVersion,
                counts, lastTripReason: r.lastTripReason, requestsServed: counts.canary.sinceStart.responses,
                promotable: this.#promotable(r, now), receipt: { lastStep: null, intent: null, failurePhase: null },
            };
        });
        const baselines = Array.from(this.#baselines, ([routeKey, counts]) => ({ routeKey, ...counts.snapshot(now) }));
        return { rollouts, baselines };
    }
}
