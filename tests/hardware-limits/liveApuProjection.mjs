// Used in both the confined Router helper and the host projection. Keep this
// function self-contained so its serialized form has exactly the same policy.
export function projectApuEvidence(input, sinceSeq = 0, projected = false) {
    const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const number = value => Number.isFinite(value) && value >= 0 ? value : null;
    const id = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null;
    const bool = value => typeof value === 'boolean' ? value : null;
    const params = value => value ? { ctxSize: int(value.ctxSize), parallel: int(value.parallel) } : null;
    const activity = value => value ? { schema: value.schema === 1 ? 1 : null, controllerInstanceId: id(value.controllerInstanceId),
        sampledMonotonicMs: number(value.sampledMonotonicMs), modelJobsStarted: int(value.modelJobsStarted),
        runnerInstallsStarted: int(value.runnerInstallsStarted), modelLookupsStarted: int(value.modelLookupsStarted),
        activeModelJobs: int(value.activeModelJobs), activeRunnerInstalls: int(value.activeRunnerInstalls),
        activeModelLookups: int(value.activeModelLookups), runnerRunning: bool(value.runnerRunning), valid: bool(value.valid) } : null;
    const attempt = input?.apuAttempt;
    if (attempt) return { apuAttempt: { schema: attempt.schema === 1 ? 1 : null, attemptId: id(attempt.attemptId),
        controllerInstanceId: id(attempt.controllerInstanceId), requestId: id(attempt.requestId), modelId: id(attempt.modelId),
        runnerId: id(attempt.runnerId), params: params(attempt.params), boundary: attempt.boundary === 'initial-admission' ? attempt.boundary : null,
        before: activity(attempt.before), after: activity(attempt.after) } };
    const launch = input?.apuObservation;
    const stop = launch?.guardStop;
    const observation = launch ? { controllerInstanceId: id(launch.controllerInstanceId), deploymentId: id(launch.deploymentId),
        requestId: id(launch.requestId), pid: int(launch.pid), command: launch.command === '/opt/llama.cpp-vulkan/llama-server' ? launch.command : null,
        launchSeq: int(launch.launchSeq), logSeqStart: int(launch.logSeqStart), startedMonotonicMs: number(launch.startedMonotonicMs),
        running: bool(launch.running), firstSeq: int(launch.firstSeq), nextSeq: int(launch.nextSeq),
        guardStop: stop ? { kind: stop.kind === 'host-memory-floor' ? stop.kind : null, seq: int(stop.seq),
            floorBytes: int(stop.floorBytes), availableBytes: int(stop.availableBytes), killRequestedMonotonicMs: number(stop.killRequestedMonotonicMs),
            settledMonotonicMs: number(stop.settledMonotonicMs), settlement: ['pending', 'resolved', 'rejected'].includes(stop.settlement) ? stop.settlement : null,
            valid: bool(stop.valid) } : null } : null;
    const kinds = ['launch', 'load-begin', 'phase-starting', 'phase-ready', 'phase-stopping', 'phase-idle', 'phase-error', 'guard-floor', 'other'];
    const source = input?.logs;
    const nextSeq = int(input?.nextSeq);
    let continuous = Array.isArray(source) && source.length <= 200 && int(sinceSeq) !== null && nextSeq !== null;
    let cursor = sinceSeq;
    // Validate every sequence before event recognition or bounding. The source
    // returns its LAST 200 rows; first-row loss cannot imply an absent ready.
    if (Array.isArray(source)) for (const row of source) {
        if (int(row?.seq) === null || row.seq !== cursor + 1) continuous = false;
        cursor = row?.seq;
    }
    if (cursor !== nextSeq || projected && input.coverage?.continuous !== true) continuous = false;
    const logs = (Array.isArray(source) ? source : []).slice(-200).map(row => {
        let kind = 'other';
        if (projected) kind = kinds.includes(row.kind) ? row.kind : 'other';
        else if (row.stream === 'controller') {
            if (row.seq === observation?.launchSeq && typeof row.line === 'string' && row.line.startsWith('starting /opt/llama.cpp-vulkan/llama-server ')) kind = 'launch';
            const phase = /^phase (starting|ready|stopping|idle|error)(?::|$)/.exec(row.line || '');
            if (phase) kind = `phase-${phase[1]}`;
            if (row.seq === stop?.seq && stop.kind === 'host-memory-floor') kind = 'guard-floor';
        } else if (['stdout', 'stderr'].includes(row.stream) && typeof row.line === 'string'
            && row.line.includes('loading model tensors, this can take a while...')) kind = 'load-begin';
        return { seq: int(row.seq), kind };
    });
    const d = input?.deployment;
    const report = input?.runnerReport;
    const phase = value => ['idle', 'starting', 'ready', 'stopping', 'error', 'downloading', 'paused'].includes(value) ? value : null;
    return { phase: phase(input?.phase), profile: ['apu', 'cpu'].includes(input?.profile) ? input.profile : null,
        deployment: d ? { id: id(d.id), requestId: id(d.requestId), logSeqStart: int(d.logSeqStart), modelId: id(d.modelId), runnerId: id(d.runnerId),
            profile: ['apu', 'cpu'].includes(d.profile) ? d.profile : null, phase: phase(d.phase), params: params(d.params),
            error: d.error ? 'deployment-error' : null,
            artifact: d.artifact ? Object.fromEntries(['repo', 'file', 'commit', 'size', 'sha256'].map(key => [key,
                key === 'size' ? int(d.artifact[key]) : typeof d.artifact[key] === 'string' && /^[A-Za-z0-9_./-]{1,256}$/.test(d.artifact[key]) ? d.artifact[key] : null])) : null } : null,
        runnerReport: report ? { device: /^(?:Vulkan0|CPU)(?: \([^\n]{1,256}\))?$/.test(report.device || '') ? report.device : null,
            offloaded: report.offloaded ? { layers: int(report.offloaded.layers), of: int(report.offloaded.of) } : null,
            modelMiB: number(report.modelMiB), kvMiB: number(report.kvMiB), computeMiB: number(report.computeMiB), vulkan0ModelBytes: number(report.vulkan0ModelBytes),
            vulkan0KvBytes: number(report.vulkan0KvBytes), modelBufferRatio: number(report.modelBufferRatio),
            modelBufferDenominatorBytes: number(report.modelBufferDenominatorBytes), minModelBufferFraction: number(report.minModelBufferFraction) } : null,
        apuActivity: activity(input?.apuActivity), apuObservation: observation, logs, nextSeq,
        coverage: { sinceSeq: int(sinceSeq), continuous, overflow: !Array.isArray(source) || source.length > 200,
            firstSeq: logs[0]?.seq ?? null, lastSeq: logs.at(-1)?.seq ?? null } };
}

export function createApuTrace(launch, { limit = 2000 } = {}) {
    launch = structuredClone(launch);
    const events = []; let cursor = launch.logSeqStart; let problem = null;
    const identity = ['controllerInstanceId', 'deploymentId', 'requestId', 'pid', 'command', 'launchSeq', 'logSeqStart', 'startedMonotonicMs'];
    return {
        append(status) {
            const current = status?.apuObservation;
            if (!current || identity.some(key => current[key] !== launch[key])) problem ||= 'stale-launch';
            if (status?.coverage?.continuous !== true || status.coverage.sinceSeq !== cursor) problem ||= 'sequence-gap';
            for (const row of status?.logs || []) {
                if (row.seq !== cursor + 1) problem ||= 'sequence-gap';
                cursor = row.seq;
                if (events.length < limit) events.push({ seq: row.seq, kind: row.kind });
                else problem ||= 'evidence-overflow';
            }
            if (cursor !== status?.nextSeq) problem ||= 'sequence-gap';
            return problem;
        },
        snapshot: () => ({ launch: { ...launch }, events: [...events], nextSeq: cursor, problem }),
        get nextSeq() { return cursor; },
    };
}
