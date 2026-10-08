#!/usr/bin/env node
/**
 * Enumerate the mandatory checks from probe definitions crossed with actors.
 * It never reads a run report. Inline check IDs of the account, resource and
 * stream modules are listed as templates here; a harness test proves every
 * template matches a literal ctx.check(...) in the module source, so a renamed
 * check makes the mandatory ID missing (fail closed) rather than silently
 * optional.
 *
 *   node mandatory-checks.mjs --check | --write
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { routerProbes } from '../router-probes.mjs';
import { agentProbes, agentReadTools, agentDiscoveryMethods } from '../agent-probes.mjs';
import { templateCheckDefinitions, marketplaceCheckDefinitions } from '../boundary-probes.mjs';
import { webchatCheckDefinitions } from '../webchat-probes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MANDATORY_FILE = path.join(here, 'mandatory-checks.json');
const readJson = name => JSON.parse(fs.readFileSync(path.join(here, name), 'utf8'));

const actorsFor = role => role === 'user' ? ['userA', 'userB'] : [role];
const nonAdmin = ['anonymous', 'selfRegistered', 'userA', 'userB'];

/** Router probes excluded from the mandatory set, with the plan's reason. */
export const NON_MANDATORY_ROUTER = Object.freeze([
    { pattern: /^users-list\.path-/, reason: 'Raw-path normalization boundary evidence only (plan rev4 F2); canonical users-list allow/deny stay mandatory' },
    { pattern: /^openai-agent-discovery\./, reason: 'Negative-only: no positive signed-agent control (plan rev4 edit 5)' },
]);

/** Inline check templates: [module, template, expansions, positiveControlAnyOf]. */
export const INLINE_TEMPLATES = Object.freeze([
    ['account-probes.mjs', 'users.admin-positive-update', [[]], null],
    ['account-probes.mjs', 'users.roles-escalation.${actor}', nonAdmin.map(a => [a]), ['users.admin-positive-update']],
    ['account-probes.mjs', 'users.csrf.${name}', ['missing-origin', 'foreign-origin', 'invalid-csrf', 'missing-csrf'].map(n => [n]), ['users.admin-positive-update']],
    ['account-probes.mjs', 'profile.actor-and-role-argument-binding', [[]], null],
    ['account-probes.mjs', 'dashboard.admin-role-escalation.${actor}', ['selfRegistered', 'userA'].map(a => [a]), ['users.admin-positive-update']],
    ['account-probes.mjs', 'sessions.role-demotion-current-session', [[]], null],
    ['account-probes.mjs', 'sessions.logout-cookie-replay', [[]], null],
    ['resource-probes.mjs', 'resource.dpu.owner-fixture', [[]], null],
    ['resource-probes.mjs', 'resource.dpu.${principal}.read', ['anonymous', 'selfRegistered', 'userB'].map(a => [a]), ['resource.dpu.owner-fixture']],
    ['resource-probes.mjs', 'resource.dpu.${principal}.update', ['anonymous', 'selfRegistered', 'userB'].map(a => [a]), ['resource.dpu.owner-fixture']],
    ['resource-probes.mjs', 'resource.dpu.userB.forged-identity', [[]], ['resource.dpu.owner-fixture']],
    ['resource-probes.mjs', 'resource.dpu.userB.delete', [[]], ['resource.dpu.owner-fixture']],
    ['resource-probes.mjs', 'resource.dpu.read-grant-and-revocation', [[]], null],
    ['resource-probes.mjs', 'resource.files.owner-fixture', [[]], null],
    ['resource-probes.mjs', 'resource.files.shared-ordinary-positive', [[]], null],
    ['resource-probes.mjs', 'resource.files.${principal}.read', ['anonymous', 'selfRegistered'].map(a => [a]), ['resource.files.owner-fixture']],
    ['resource-probes.mjs', 'resource.files.${principal}.write', ['anonymous', 'selfRegistered'].map(a => [a]), ['resource.files.owner-fixture']],
    ['resource-probes.mjs', 'resource.tasks.owner-fixture', [[]], null],
    ['resource-probes.mjs', 'resource.tasks.shared-ordinary-positive', [[]], null],
    ['resource-probes.mjs', 'resource.tasks.${principal}.get', ['anonymous', 'selfRegistered'].map(a => [a]), ['resource.tasks.owner-fixture']],
    ['resource-probes.mjs', 'resource.tasks.${principal}.update', ['anonymous', 'selfRegistered'].map(a => [a]), ['resource.tasks.owner-fixture']],
    ['resource-probes.mjs', 'resource.tasks.argument-root-boundary', [[]], ['resource.tasks.owner-fixture']],
    ['resource-probes.mjs', 'resource.git.local-fixture', [[]], null],
    ['resource-probes.mjs', 'resource.git.shared-ordinary-positive', [[]], null],
    ['resource-probes.mjs', 'resource.git.${principal}.status', ['anonymous', 'selfRegistered'].map(a => [a]), ['resource.git.local-fixture']],
    ['resource-probes.mjs', 'resource.webmeet.admin-fixture', [[]], null],
    ['resource-probes.mjs', 'resource.webmeet.${principal}.shared-room-positive', ['userA', 'userB'].map(a => [a]), null],
    ['resource-probes.mjs', 'resource.webmeet.${principal}.rename', ['selfRegistered', 'userA', 'userB'].map(a => [a]), ['resource.webmeet.admin-fixture']],
    ['resource-probes.mjs', 'resource.webmeet.${principal}.delete', ['selfRegistered', 'userA', 'userB'].map(a => [a]), ['resource.webmeet.admin-fixture']],
    ['stream-probes.mjs', 'router:workspace-file-fixture-positive:${actor}', ['admin', 'userA', 'userB'].map(a => [a]), null],
    ['stream-probes.mjs', "router:workspace-file-selector-deny:${actor}:${selector || 'default'}", ['anonymous', 'selfRegistered'].flatMap(a => ['default', '?agent=authorization-suite-nonexistent', '?agent=userPersistoAgent'].map(s => [a, s])), ['router:workspace-file-fixture-positive:admin', 'router:workspace-file-fixture-positive:userA', 'router:workspace-file-fixture-positive:userB']],
    ['stream-probes.mjs', 'router:terminal-discovery-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-discovery-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-discovery-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-create-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-discovery-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-create-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-sse-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-resize-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-harmless-command-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-sse-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-sse-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-input-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-harmless-command-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-resize-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-resize-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-delete-deny:${actor}', nonAdmin.map(a => [a]), ['router:terminal-create-positive:admin']],
    ['stream-probes.mjs', 'router:terminal-delete-positive:admin', [[]], null],
    ['stream-probes.mjs', 'router:terminal-discovery-cleanup:admin', [[]], null],
    ['stream-probes.mjs', 'router:mcp-session-create-positive:${actor}', ['userA', 'userB'].map(a => [a]), null],
    ['stream-probes.mjs', 'router:mcp-session-delete-own-positive:userA', [[]], null],
    ['stream-probes.mjs', 'router:mcp-session-horizontal-delete-deny:userA-to-userB', [[]], ['router:mcp-session-delete-own-positive:userA']],
]);

/** Offline tests that must be `ok` at the pinned commit (plan rev3 table, unchanged by rev4). */
export const OFFLINE = Object.freeze([
    { repo: 'ploinky', file: 'tests/unit/templateRevalidation.test.mjs', boundary: 'U3', tests: [] },
    { repo: 'ploinky', file: 'tests/unit/agentServerStaticCache.test.mjs', boundary: 'U3', tests: [] },
    { repo: 'ploinky', file: 'tests/unit/webchatPrincipalRuntime.test.mjs', boundary: 'U6', tests: [
        'runtime scope principal: a delayed close of an evicted runtime never unregisters its live replacement',
        'runtime scope principal: late task output from an evicted runtime never reaches its replacement',
    ] },
    { repo: 'ploinky', file: 'tests/unit/webchatInteraction.test.mjs', boundary: 'U6', tests: [] },
    { repo: 'ploinky', file: 'tests/unit/webchatSlashCommandsSecurity.test.mjs', boundary: 'U6', tests: [] },
    { repo: 'AchillesIDE', file: 'dpuAgent/tests/webchat-sso-authorization.test.mjs', boundary: 'U6', tests: [] },
    { repo: 'ploinky', file: 'tests/unit/marketplaceRepositoryPrespawnRetry.test.mjs', boundary: 'U7', tests: [] },
    { repo: 'ploinky', file: 'tests/unit/marketplaceRepositoryWorkerRoutes.test.mjs', boundary: 'U7', tests: [] },
    { repo: 'ploinky', file: 'tests/security/authorization/lease-readonly.test.mjs', boundary: 'U7', tests: [
        'request-path lease commit() writes nothing to the workspace',
    ] },
]);

export function expandTemplate(template, values) {
    let index = 0;
    return template.replace(/\$\{[^}]+\}/g, () => values[index++]);
}

export function enumerateMandatoryChecks({ expectedRuntimes, expectedGaps }) {
    const checks = new Map();
    const add = (id, entry) => {
        if (checks.has(id)) {
            const existing = checks.get(id);
            existing.count += entry.count || 1;
            if (existing.positiveControlAnyOf || entry.positiveControlAnyOf) existing.positiveControlAnyOf = [...new Set([...(existing.positiveControlAnyOf || []), ...(entry.positiveControlAnyOf || [])])].sort();
        }
        else checks.set(id, { id, kind: 'live', count: 1, positiveControlAnyOf: null, ...entry });
    };
    const gapIds = new Set(expectedGaps.gaps.map(g => g.id));

    // Router probes (router-probes.mjs routerProbes) crossed with actors.
    const routerSource = 'tests/security/authorization/router-probes.mjs routerProbes';
    const positiveActors = new Map(routerProbes.filter(p => p.expect === 'allow').map(p => [p.id, p.roles.flatMap(actorsFor)]));
    for (const probe of routerProbes) {
        if (NON_MANDATORY_ROUTER.some(rule => rule.pattern.test(probe.id))) continue;
        for (const actor of probe.roles.flatMap(actorsFor)) {
            const positives = probe.positiveControl ? positiveActors.get(probe.positiveControl).map(a => `router:${probe.positiveControl}:${a}`) : null;
            assert.ok(probe.expect === 'allow' || positives, `deny probe ${probe.id} needs a positive control`);
            add(`router:${probe.id}:${actor}`, { boundary: 'router', source: routerSource, positiveControlAnyOf: positives });
        }
        if (probe.id === 'marketplace-repos.allow' || probe.id === 'marketplace-agents.allow') {
            for (const actor of probe.roles.flatMap(actorsFor)) add(`router:marketplace-sensitive-path-metadata:${actor}`, { boundary: 'U7', source: 'tests/security/authorization/router-probes.mjs:204-208 (one check per marketplace read probe)', positiveControlAnyOf: [`router:${probe.id}:${actor}`] });
        }
    }

    // Agent HTTP and MCP read probes (agent-probes.mjs agentProbes/agentReadTools).
    add('agent.registry.reconciliation', { boundary: 'agents', source: 'tests/security/authorization/agent-probes.mjs runAgentProbes' });
    for (const probe of agentProbes) {
        add(`${probe.id}.admin`, { boundary: 'agents', source: 'agent-probes.mjs agentProbes' });
        for (const actor of nonAdmin) add(`${probe.id}.${actor}`, { boundary: 'agents', source: 'agent-probes.mjs agentProbes', positiveControlAnyOf: [`${probe.id}.admin`] });
    }
    for (const probe of agentReadTools) {
        add(`agent.tool.${probe.tool}.admin`, { boundary: 'agents', source: 'agent-probes.mjs agentReadTools' });
        for (const actor of nonAdmin) add(`agent.tool.${probe.tool}.${actor}`, { boundary: 'agents', source: 'agent-probes.mjs agentReadTools', positiveControlAnyOf: [`agent.tool.${probe.tool}.admin`] });
    }
    // Discovery and SSE for every required (enabled) agent. A discovery method
    // is mandatory exactly when no reviewed -32601 exclusion exists for it.
    for (const { agent } of expectedRuntimes.enabled) {
        for (const { method } of agentDiscoveryMethods) {
            const id = `agent.${agent}.discovery.${method.replaceAll('/', '.')}`;
            if (gapIds.has(id)) continue;
            add(`${id}.positive`, { boundary: 'agents', source: 'agent-probes.mjs discoverAgentMcp' });
            for (const actor of nonAdmin) add(`${id}.${actor}`, { boundary: 'agents', source: 'agent-probes.mjs discoverAgentMcp', positiveControlAnyOf: [`${id}.positive`] });
        }
        add(`agent.${agent}.sse.positive`, { boundary: 'agents', source: 'agent-probes.mjs discoverAgentMcp (SSE)' });
        for (const actor of ['anonymous', 'selfRegistered', 'userB']) add(`agent.${agent}.sse.cross-session.${actor}`, { boundary: 'agents', source: 'agent-probes.mjs discoverAgentMcp (SSE)', positiveControlAnyOf: [`agent.${agent}.sse.positive`] });
    }
    add('agent.username-admin.profile-positive', { boundary: 'agents', source: 'agent-probes.mjs usernamePrivilegeProbe' });
    for (const id of ['persisted-role', 'monitor-denial', 'webmeet-role']) add(`agent.username-admin.${id}`, { boundary: 'agents', source: 'agent-probes.mjs usernamePrivilegeProbe', positiveControlAnyOf: ['agent.username-admin.profile-positive'] });

    for (const [module, template, expansions, positives] of INLINE_TEMPLATES) {
        for (const values of expansions) add(expandTemplate(template, values), { boundary: module.replace('-probes.mjs', ''), source: `tests/security/authorization/${module}`, positiveControlAnyOf: positives });
    }
    for (const definition of [...templateCheckDefinitions(), ...marketplaceCheckDefinitions(), ...webchatCheckDefinitions()]) add(definition.id, definition);
    for (const offline of OFFLINE) add(`offline:${offline.repo}:${offline.file}`, { kind: 'offline', boundary: offline.boundary, repo: offline.repo, file: offline.file, tests: offline.tests, source: 'plan rev3 mandatory-check table (unchanged in rev4)' });

    const list = [...checks.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const entry of list) {
        assert.ok(!gapIds.has(entry.id), `MANDATORY_GAP_OVERLAP: ${entry.id} is both mandatory and an expected gap`);
        for (const pc of entry.positiveControlAnyOf || []) assert.ok(checks.has(pc), `MANDATORY_POSITIVE_UNKNOWN: ${entry.id} -> ${pc}`);
    }
    return { schema: 'authz-mandatory-checks/1', nonMandatoryRouter: NON_MANDATORY_ROUTER.map(r => ({ pattern: r.pattern.source, reason: r.reason })), counts: { live: list.filter(c => c.kind === 'live').length, offline: list.filter(c => c.kind === 'offline').length }, checks: list };
}

export function main(argv = process.argv.slice(2)) {
    const mode = argv[0];
    if (!['--check', '--write'].includes(mode) || argv.length !== 1) { console.error('use --check or --write'); return 1; }
    const derived = enumerateMandatoryChecks({ expectedRuntimes: readJson('expected-runtimes.json'), expectedGaps: readJson('expected-gaps.json') });
    console.log(`mandatory live=${derived.counts.live} offline=${derived.counts.offline}`);
    if (mode === '--write') { fs.writeFileSync(MANDATORY_FILE, JSON.stringify(derived, null, 2) + '\n'); console.log(`wrote ${MANDATORY_FILE}`); return 0; }
    try { assert.deepEqual(derived, readJson('mandatory-checks.json')); }
    catch { console.error('MANDATORY_CHECKS_DRIFT: committed mandatory-checks.json differs from the enumerator output'); return 1; }
    console.log('mandatory-checks.json equals the enumerator output');
    return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = main(); } catch (error) { console.error(error?.message || String(error)); process.exitCode = 1; }
}
