import {
    assertOuterPublicationCoverageForClaims,
    isPloinkyBoxRuntime,
    parseOuterPublicationContract,
} from './docker/common.js';
import { createBoxStartPublishPlan } from './boxStartPublishPlan.js';
import { parseStartArgs } from './repos.js';

const STARTING_COMMANDS = new Set(['start', 'enable', 'cli', 'shell', 'restart', 'reinstall']);

export async function preflightBoxPublicationForCommand(command, options = [], overrides = {}) {
    const normalizedCommand = String(command || '').trim().toLowerCase();
    if (!STARTING_COMMANDS.has(normalizedCommand)) {
        return { enforced: false, skipped: true };
    }
    const inBox = overrides.boxRuntime === true
        || (overrides.boxRuntime !== false && isPloinkyBoxRuntime(overrides.markerPath));
    if (!inBox) return { enforced: false, skipped: true };

    // Validate the bounded environment handoff before repository preparation.
    // Repository checkout preparation is the planner's only allowed mutation,
    // but a malformed supervisor contract should still fail as early as possible.
    const contract = parseOuterPublicationContract(overrides.contract);
    const request = plannerRequestForCommand(normalizedCommand, options, overrides);
    if (!request) return { enforced: false, skipped: true };
    const plan = await (overrides.createPlan || createBoxStartPublishPlan)(request, overrides.planOptions || {});
    const commandHint = overrides.commandHint || formatHostCommand(normalizedCommand, options);
    const coverage = assertOuterPublicationCoverageForClaims(plan.claims, {
        boxRuntime: true,
        contract,
        commandHint,
    });
    return { enforced: true, skipped: false, plan, coverage };
}

export function plannerRequestForCommand(command, options = [], overrides = {}) {
    const values = (options || []).map((entry) => String(entry));
    const base = {
        schemaVersion: 2,
        operation: command,
        routerPort: overrides.routerPort || 8080,
    };
    if (command === 'start') {
        const parsed = parseStartArgs(values);
        return {
            ...base,
            root: parsed.staticAgent || undefined,
            profile: parsed.profile || undefined,
            branchPolicy: parsed.branchPolicy,
            includeEnabled: true,
        };
    }
    if (command === 'cli') {
        if (!values[0]) return null;
        return { ...base, root: values[0], includeEnabled: false };
    }
    if (command === 'shell') {
        if (!values[0]) return null;
        return { ...base, root: values[0], includeEnabled: false };
    }
    if (command === 'reinstall') {
        const root = values[0]?.toLowerCase() === 'agent' ? values[1] : values[0];
        if (!root) return null;
        return { ...base, root, includeEnabled: false };
    }
    if (command === 'restart') {
        const root = values[0] && values[0].toLowerCase() !== 'router' ? values[0] : undefined;
        return { ...base, root, includeEnabled: !root };
    }
    if (command === 'enable') {
        const first = String(values[0] || '').toLowerCase();
        if (['repo', 'repository', 'sandbox', 'host-sandbox', 'lite-sandbox'].includes(first)) return null;
        const args = first === 'agent' ? values.slice(1) : values;
        const root = args[0];
        if (!root) return null;
        const aliasIndex = args.findIndex((entry) => entry.toLowerCase() === 'as');
        const alias = aliasIndex >= 0 ? args.slice(aliasIndex + 1).join(' ').trim() : '';
        return { ...base, root, alias: alias || undefined, includeEnabled: false };
    }
    return null;
}

function formatHostCommand(command, options) {
    return ['ploinky', command, ...(options || [])]
        .map(shellQuote)
        .join(' ');
}

function shellQuote(value) {
    const raw = String(value || '');
    return /^[A-Za-z0-9_./:=+-]+$/.test(raw)
        ? raw
        : `'${raw.replace(/'/g, `'\\''`)}'`;
}
