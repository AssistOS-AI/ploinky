// Update-only Git resolution. This module reads effective install inputs and
// updates pin metadata; it never probes an image, prepares an object or runs npm.
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from '../../config.js';
import { readAgentRegistrySnapshot } from '../../agentRegistrySnapshot.js';
import { resolveAgentRepositoryPath } from '../../agentRepositorySource.mjs';
import { readGlobalDepsPackage, mergePackageJson } from '../dependencyInstaller.js';
import { assertNoReservedAgentLibDependency } from '../agentLibLink.js';
import { activeBoxMcpSdkBundle, withoutBoxMcpSdk } from '../../../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import { withHeldOrAcquiredWorkspaceMutationLease, assertWorkspaceMutationLease } from '../../runtime/maintenanceLocks.js';
import { createOperationRecord } from '../../../commands/updateOutcome.js';
import { canonicalDigest } from './canonical.mjs';
import { createCacheStore } from './objectStore.mjs';
import { agentPackageSourceAt, registrationIdFor } from './runtimeDependencies.mjs';
import { collectGitInputs, discoverGitPins, mergeDiscoveredPins } from './gitPins.mjs';

const REPOSITORY_PHASES = new Set(['registered-repository', 'workspace-repository']);
const VERIFIED = new Set(['changed', 'unchanged']);

function canonical(target) {
    return fs.realpathSync(path.resolve(target));
}

function outcomePath(record) {
    const target = record?.details?.checkout?.path;
    if (!target) return null;
    try { return canonical(target); } catch { return path.resolve(target); }
}

function sourceOutcome(record, repoPath, outcomes) {
    return outcomes.filter(item => REPOSITORY_PHASES.has(item?.phase)).find(item =>
        item.id === record.repoName || item.details?.aliases?.includes(record.repoName)
        || outcomePath(item) === repoPath);
}

function recordFor(id, outcome, code, reason, details = {}, attempted = true, required = true) {
    return createOperationRecord({ phase: 'git-pin', id, outcome, code, reason, attempted, required,
        details: { ...details, requirementFixed: true } });
}

function pinInputs(record, registration, repoPath, workspaceRoot, globalPackage, sdkBundle) {
    const agentRoot = path.join(repoPath, record.agentName);
    const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'manifest.json'), 'utf8'));
    const source = fs.existsSync(path.join(agentRoot, 'code')) ? path.join(agentRoot, 'code') : agentRoot;
    const selectedSource = canonical(source);
    // Read the qualified source that the next lifecycle prepares. The current
    // short-name code link can still describe the previous deployment (for
    // example before a newly introduced code/ directory is linked).
    const agentPackage = agentPackageSourceAt(selectedSource, { workspaceRoot });
    const binding = { scope: 'registration', registration: registrationIdFor(registration), packageSource: agentPackage.relativePath };
    const global = withoutBoxMcpSdk(assertNoReservedAgentLibDependency(globalPackage, 'globalDeps/package.json'), { bundle: sdkBundle });
    const agent = withoutBoxMcpSdk(assertNoReservedAgentLibDependency(agentPackage.manifest || {}, 'agent package.json'), { bundle: sdkBundle });
    const profile = manifest.profiles?.[record.profile];
    const start = typeof manifest.start === 'string' ? manifest.start.trim() : '';
    const needsDependencies = Boolean(agentPackage.manifest) || !start
        || manifest.llmRuntime?.enabled === true || profile?.llmRuntime?.enabled === true;
    return {
        binding,
        global,
        needsDependencies,
        ...collectGitInputs(needsDependencies ? mergePackageJson(global, agent) : {}, binding),
    };
}

/**
 * Refresh pins for enabled registrations in the caller's repository operation
 * set. A null repositoryNames selects all enabled registrations. Supplying
 * sourceOutcomes enforces verified Git-source outcomes before reading inputs.
 * All reads, resolution and compare/merge share the workspace mutation lease.
 */
export async function refreshUpdateGitPins({
    repositoryNames = null,
    sourceOutcomes = null,
    workspaceMutationLease = null,
} = {}, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    readRegistry = () => readAgentRegistrySnapshot({ workspaceRoot }),
    repositoryPath = resolveAgentRepositoryPath,
    readGlobalPackage = readGlobalDepsPackage,
    readSdkBundle = activeBoxMcpSdkBundle,
    store: suppliedStore = null,
    discover = discoverGitPins,
    discoveryOptions = {},
    withLease = withHeldOrAcquiredWorkspaceMutationLease,
    assertLease = assertWorkspaceMutationLease,
} = {}) {
    const perform = (lease) => {
        const records = [];
        let registry;
        try { registry = readRegistry(); }
        catch (error) {
            return { records: [recordFor('registry', 'uncertain', 'git-pin-registry-unreadable', error.message)], queriesRun: 0, changed: false };
        }
        const names = repositoryNames === null ? null : new Set(repositoryNames.map(String));
        const selected = [];
        for (const [registration, record] of Object.entries(registry || {})) {
            if (registration === '_config' || record?.type !== 'agent') continue;
            if (!record.repoName || !record.agentName) {
                records.push(recordFor(registration, 'uncertain', 'git-pin-registration-invalid', 'enabled registration has no exact repository/agent identity'));
                continue;
            }
            let repoPath;
            try { repoPath = canonical(repositoryPath(record.repoName)); }
            catch (error) {
                if (!names || names.has(record.repoName)) records.push(recordFor(registration, 'failed', 'git-pin-source-unavailable', error.message));
                continue;
            }
            const outcome = sourceOutcome(record, repoPath, sourceOutcomes || []);
            if (names && !names.has(record.repoName) && !outcome) continue;
            if (sourceOutcomes !== null && (!outcome || !VERIFIED.has(outcome.outcome))) {
                records.push(recordFor(registration, 'skipped', 'git-pin-source-not-verified',
                    `Git pins preserved because repository ${record.repoName} was not verified by this update`, { repository: record.repoName }, false));
                continue;
            }
            selected.push({ registration, record, repoPath });
        }
        if (!selected.length) return { records, queriesRun: 0, changed: false };
        const store = suppliedStore || createCacheStore({ depsDir: path.join(workspaceRoot, '.ploinky', 'deps'), workspaceRoot, assertLease });
        let globalPackage, sdkBundle;
        try { globalPackage = readGlobalPackage(); sdkBundle = readSdkBundle(); }
        catch (error) {
            records.push(recordFor('providers', 'failed', 'git-pin-provider-input-invalid', error.message));
            return { records, queriesRun: 0, changed: false };
        }
        const entries = [], unsupported = [], bindings = [];
        let globalInput = null;
        for (const item of selected) {
            try {
                const inputs = pinInputs(item.record, item.registration, item.repoPath, workspaceRoot, globalPackage, sdkBundle);
                bindings.push(inputs.binding);
                entries.push(...inputs.entries);
                unsupported.push(...inputs.unsupported);
                if (inputs.needsDependencies) globalInput = inputs.global;
            } catch (error) {
                records.push(recordFor(item.registration, 'failed', 'git-pin-input-invalid', error.message, { repository: item.record.repoName }));
            }
        }
        if (globalInput) {
            const binding = { scope: 'global' };
            bindings.push(binding);
            const seed = collectGitInputs(globalInput, binding);
            entries.push(...seed.entries);
            unsupported.push(...seed.unsupported);
        }
        if (!bindings.length) return { records, queriesRun: 0, changed: false };
        let discovery, merged, changed;
        try {
            discovery = discover(entries, { ...discoveryOptions, unsupported });
            const current = store.readPins().pins;
            const registrations = new Set(bindings.filter(binding => binding.scope === 'registration').map(binding => binding.registration));
            // A source can move between root/package.json and code/package.json.
            // Retire old bindings of registrations whose inputs were read
            // successfully, while preserving failed/unselected registrations.
            const mergeBindings = [...bindings, ...Object.values(current)
                .map(pin => pin.binding).filter(binding => binding?.scope === 'registration' && registrations.has(binding.registration))];
            merged = mergeDiscoveredPins(current, entries, discovery.results, { bindings: mergeBindings });
            changed = canonicalDigest(current) !== canonicalDigest(merged.pins);
            if (changed) store.updatePins(lease, latest => mergeDiscoveredPins(latest, entries, discovery.results, { bindings: mergeBindings }).pins);
        } catch (error) {
            records.push(recordFor('publication', 'uncertain', 'git-pin-publication-failed', error.message));
            return { records, queriesRun: discovery?.queriesRun || 0, changed: false };
        }
        const byId = new Map(entries.map(entry => [entry.pinId, entry]));
        const changes = new Map(merged.changes.map(change => [change.pinId, change]));
        for (const result of discovery.results) {
            const entry = byId.get(result.pinId);
            const change = changes.get(result.pinId);
            const details = { registration: entry?.binding?.registration || null, dependency: entry?.name || null,
                section: entry?.section || null, retainedPin: change?.action === 'retained-after-failure' };
            if (result.status === 'unsupported') {
                records.push(recordFor(result.pinId, 'skipped', 'git-pin-unsupported', result.reason, details, false, false));
            } else if (result.status === 'fixed' || result.status === 'resolved') {
                records.push(recordFor(result.pinId, change?.action === 'pinned' ? 'changed' : 'unchanged',
                    result.status === 'fixed' ? 'git-pin-exact-spec' : 'git-pin-verified',
                    `${entry?.name || 'Git dependency'} uses ${result.commit}`, details, result.status !== 'fixed'));
            } else {
                records.push(recordFor(result.pinId, 'failed', `git-pin-${result.status}`,
                    `${entry?.name || 'Git dependency'}: ${result.reason || result.status}${details.retainedPin ? '; previous same-spec pin retained' : ''}`, details));
            }
        }
        for (const change of merged.changes) {
            if (change.action === 'removed-undeclared') records.push(recordFor(change.pinId, 'changed', 'git-pin-removed', 'removed pin for a dependency no longer declared'));
        }
        return { records, queriesRun: discovery.queriesRun, changed };
    };
    if (workspaceMutationLease) return perform(assertLease(workspaceMutationLease));
    return withLease({ operation: 'update-git-pins' }, perform);
}
