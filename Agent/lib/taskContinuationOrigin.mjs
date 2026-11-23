import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'pcq1_';
const ALIAS = /^pcq1_([A-Za-z0-9_-]{22})([A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const TOOL = /^[A-Za-z0-9._-]{1,160}$/;
const HANDLE = /^[A-Za-z0-9_-]{16,200}$/;

export function isContinuationToolAlias(name) {
    return typeof name === 'string' && ALIAS.test(name);
}

function aliasFor(secret, rolloutId, handle, tool) {
    const tag = createHmac('sha256', secret)
        .update(JSON.stringify(['ploinky-task-tool-v1', rolloutId, handle, tool]))
        .digest().subarray(0, 16).toString('base64url');
    return PREFIX + tag + rolloutId;
}

function mapContinuations(task, transform) {
    const live = task.liveContinuation;
    const metadata = task.result?.metadata;
    if (!live && !metadata?.continuation) return task;
    const mapped = { ...task };
    if (live) mapped.liveContinuation = transform(live);
    if (metadata?.continuation) {
        mapped.result = { ...task.result, metadata: { ...metadata, continuation: transform(metadata.continuation) } };
    }
    return mapped;
}

// The normal status fields and native handle stay usable by existing clients.
// A task observer can persist the extra aliases through its existing tool-name
// fields and invoke the right queue after the original status has been pruned.
export function issueContinuationOrigins(task, rolloutId, secret) {
    if (!secret?.length) return task;
    return mapContinuations(task, continuation => {
        if (typeof continuation.handle !== 'string' || !HANDLE.test(continuation.handle)
            || typeof continuation.toolName !== 'string' || !TOOL.test(continuation.toolName)) return continuation;
        const issue = tool => aliasFor(secret, rolloutId, continuation.handle, tool);
        return { ...continuation, originToolName: issue(continuation.toolName),
            ...(continuation.messageToolName && { originMessageToolName: issue(continuation.messageToolName) }) };
    });
}

export function projectContinuationTools(task) {
    return mapContinuations(task, continuation => ({
        ...continuation,
        ...(isContinuationToolAlias(continuation.originToolName) && { toolName: continuation.originToolName }),
        ...(isContinuationToolAlias(continuation.originMessageToolName) && { messageToolName: continuation.originMessageToolName }),
    }));
}

// Only a target-issued alias may choose a queue. A real native tool with the
// same spelling keeps its normal access policy and actor-based selection.
export function resolveContinuationTool(alias, handle, secret, tools) {
    const match = ALIAS.exec(alias);
    const rolloutId = match?.[2] || '';
    const candidates = match && typeof handle === 'string' && HANDLE.test(handle)
        ? tools.filter(tool => timingSafeEqual(Buffer.from(alias), Buffer.from(aliasFor(secret, rolloutId, handle, tool))))
        : [];
    if (candidates.length === 1) return { tool: candidates[0], taskPin: { rolloutId } };
    if (!candidates.length && tools.includes(alias)) return { tool: alias };
    throw new Error('Invalid task continuation origin');
}
