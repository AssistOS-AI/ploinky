import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSealedEdgeSelector, sealEdgeSelector } from '../../cli/sandbox/edgeSelectorRecord.mjs';

// The real in-Box `ploinky-local stop` always writes a fresh sealed inactive
// selector with reason `cli-workspace-stop` (cli.js, edgeGeneration.js). A
// host rollback restores the prior graph only over that selector (Q30), so a
// fake engine runner that stands in for the in-Box stop must write it too.

export function isInBoxStop(args) {
    return Array.isArray(args) && args.includes('/opt/ploinky/bin/ploinky-local') && args.at(-1) === 'stop';
}

export function selectorFile(workspaceRoot) {
    return path.join(workspaceRoot, '.ploinky', 'data', 'edge-routing', 'active.json');
}

export function writeInBoxStopSelector(workspaceRoot, { reason = 'cli-workspace-stop', previousGeneration } = {}) {
    const file = selectorFile(workspaceRoot);
    let previous = null;
    try { previous = parseSealedEdgeSelector(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const derived = previous?.state === 'active' ? previous.generation : previous?.previousGeneration || '';
    const selector = sealEdgeSelector({
        schemaVersion: 1,
        state: 'inactive',
        previousGeneration: previousGeneration ?? derived,
        reason,
        activationId: crypto.randomUUID(),
        changedAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(selector, null, 2), { mode: 0o600 });
    return selector;
}
