import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// T1-10 / A1.1 step 2 preservation: no agent-level proc unmasking, no
// recreation policy for it, the outer Box `unmask=ALL` baseline unchanged, and
// the generic T1 modules unwired except for the reviewed interim predicate.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Assembled so this file never spells the names it forbids.
const PROC_UNMASK = ['proc', 'unmask'].join('');
const UNMASK = ['un', 'mask'].join('');

const PRODUCTION_ROOTS = ['Agent', 'agentlib', 'bin', 'cli', 'container', 'core-services', 'globalDeps', 'ploinky-box', 'webLibs'];
const AGENT_LAUNCH_ROOTS = ['Agent', 'agentlib', 'bin', 'cli', 'container', 'core-services', 'globalDeps', 'webLibs'];
// Never traverse managed checkouts, dependencies or VCS state.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.ploinky', '.git']);

const NEW_MODULES = Object.freeze([
    'cli/server/executionTarget/declaration.mjs',
    'cli/server/executionTarget/contract.mjs',
    'cli/utils/runtime/sourceProtectionStore.mjs',
    'cli/utils/runtime/sourceProtectionInterlock.mjs',
    'cli/sandbox/legacyAgentAdoptionGuard.mjs',
]);
const NEW_TESTS = Object.freeze([
    'tests/unit/executionTargetDeclaration.test.mjs',
    'tests/unit/executionTargetSourceProtection.test.mjs',
    'tests/unit/legacyAgentAdoptionGuard.test.mjs',
    'tests/unit/executionTargetPreservation.test.mjs',
    'tests/unit/executionTargetCommonVectors.test.mjs',
    'tests/unit/legacyAgentMaskCompleteness.test.mjs',
]);
// The pure guard names the legacy markers only to detect them.
const GUARD = 'cli/sandbox/legacyAgentAdoptionGuard.mjs';

function* files(relative, { anyExtension = false } = {}) {
    const absolute = path.join(REPO_ROOT, relative);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
        if (anyExtension || /\.(c|m)?js$/.test(relative)) yield relative;
        return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(absolute).sort()) {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        yield* files(path.posix.join(relative, name), { anyExtension });
    }
}

function productionFiles(roots = PRODUCTION_ROOTS) {
    const out = [];
    for (const root of roots) out.push(...files(root, { anyExtension: root === 'bin' }));
    for (const name of fs.readdirSync(REPO_ROOT)) {
        if (/\.(c|m)?js$/.test(name) && fs.lstatSync(path.join(REPO_ROOT, name)).isFile()) out.push(name);
    }
    return out;
}

const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

test('T1-10 no agent-level proc-unmask module, import, call, label or recreation logic anywhere in production', () => {
    const all = [...files('.', { anyExtension: true })];
    assert.deepEqual(all.filter((relative) => path.basename(relative).toLowerCase().startsWith(PROC_UNMASK)), []);
    const offenders = [];
    for (const relative of productionFiles()) {
        if (relative === GUARD) continue;
        const text = read(relative);
        if (new RegExp(PROC_UNMASK, 'i').test(text)) offenders.push(relative);
    }
    assert.deepEqual(offenders, [], 'no procUnmask.js import/call, ploinky.procunmask label or procUnmaskChanged logic');
});

test('T1-10 no target or agent unmask argument in agent launch paths', () => {
    const offenders = [];
    for (const relative of productionFiles(AGENT_LAUNCH_ROOTS)) {
        if (relative === GUARD) continue;
        const text = read(relative);
        if (new RegExp(`\\b${UNMASK}\\b`, 'i').test(text) || /systempaths\s*[=:]\s*unconfined/i.test(text)) offenders.push(relative);
    }
    assert.deepEqual(offenders, []);
    // The guard holds the markers as detection constants only; it renders no runtime argument.
    const guard = read(GUARD);
    assert.doesNotMatch(guard, /--security-opt|--label|security-opt/);
    assert.doesNotMatch(guard, /\b(execFile|spawn|child_process|runtimeCommand)\b/);
});

test('A1.1 step 2 the outer Box unmask=ALL baseline is present, unchanged and the only Box-side occurrence', () => {
    const lifecycle = 'ploinky-box/lifecycle/container.mjs';
    const lines = read(lifecycle).split('\n');
    // P/ploinky-box/lifecycle/container.mjs:177 at the inspected base.
    assert.equal(lines[176], `        '--security-opt', '${UNMASK}=ALL',`);
    // It belongs to the outer Box `container create` argument list, not to an agent launch.
    const createIndex = lines.slice(0, 176).map((line) => line.trim()).lastIndexOf(`'container', 'create',`);
    assert.ok(createIndex >= 0 && 176 - createIndex < 20);
    assert.ok(lines.slice(createIndex, 176).some((line) => line.includes(`'--name', identity.instance`)));
    assert.ok(lines.slice(createIndex, 176).some((line) => line.includes('BOX_USERNS')));
    const boxOccurrences = [];
    for (const relative of productionFiles(['ploinky-box'])) {
        read(relative).split('\n').forEach((line, index) => {
            if (new RegExp(`\\b${UNMASK}\\b`, 'i').test(line)) boxOccurrences.push(`${relative}:${index + 1}:${line.trim()}`);
        });
    }
    assert.deepEqual(boxOccurrences.map((item) => item.replace(/:\d+:/, ':')).sort(), [
        // The owned-Box contract check expects exactly the outer baseline option.
        `ploinky-box/contract/container.mjs:'${UNMASK}=all',`,
        `${lifecycle}:'--security-opt', '${UNMASK}=ALL',`,
    ].sort());
    assert.ok(boxOccurrences.includes(`${lifecycle}:177:'--security-opt', '${UNMASK}=ALL',`));
});

test('T1-10 / T1-11 the new generic modules have no production importer and register no route', () => {
    const newNames = NEW_MODULES.map((relative) => path.basename(relative, '.mjs'));
    const operationNames = [
        'reserveWritableResources', 'prepareSourceTransition', 'releaseWritableReservation', 'acknowledgeSourceStore',
        'advanceWorkerGeneration', 'openSourceProtectionStore', 'createSourceProtectionInterlock',
        'evaluateLegacyAgentAdoption', 'evaluateInterimLegacyMarkers', 'validateExecutionTargetDeclaration',
        'readExecutionTargetDeclaration',
    ];
    const importers = [];
    for (const relative of productionFiles()) {
        if (NEW_MODULES.includes(relative)) continue;
        let text = read(relative);
        if (relative === 'cli/sandbox/legacyAgentLifecycleGuard.mjs') {
            assert.doesNotMatch(text, /normalizeAgentSecurityEvidence|sourceProtection|executionTarget\//);
            // A1.1 step 5 wires the full predicate behind a code constant that
            // stays false until a reviewed activation; the interim subset alone runs.
            assert.match(text, /^export const FULL_MASK_COMPLETENESS_ACTIVE = false;$/m);
            assert.match(text, /active = FULL_MASK_COMPLETENESS_ACTIVE,/);
            text = text.replaceAll('legacyAgentAdoptionGuard', '').replaceAll('evaluateInterimLegacyMarkers', '')
                .replaceAll('evaluateLegacyAgentAdoption', '');
        }
        if (relative === 'cli/sandbox/legacyAgentRuntimeEvidence.mjs') {
            // The step-5 evidence adapter reads only the pure identity helper.
            assert.doesNotMatch(text, /evaluateLegacyAgentAdoption|sourceProtection|executionTarget\//);
            assert.deepEqual(text.match(/^import .*legacyAgentAdoptionGuard.*$/gm),
                ["import { readContainerId } from './legacyAgentAdoptionGuard.mjs';"]);
            text = text.replaceAll('legacyAgentAdoptionGuard', '');
        }
        // Nothing in production may switch the full predicate on per call.
        if (text.includes('legacyAgentLifecycleGuard')) assert.doesNotMatch(text, /\bactive:\s*true\b/, relative);
        if (/executionTarget\//.test(text) || newNames.some((name) => name !== 'contract' && name !== 'declaration' && text.includes(name))) {
            importers.push(relative);
        }
        if (operationNames.some((name) => text.includes(name))) importers.push(relative);
    }
    assert.deepEqual([...new Set(importers)], []);
    // Among tests, only the new T1 tests reach them.
    const testImporters = [...files('tests')].filter((relative) => (
        !relative.startsWith('tests/unit/fixtures/')
        && (/executionTarget\/|sourceProtection(Store|Interlock)|legacyAgentAdoptionGuard/.test(read(relative)))
    ));
    assert.deepEqual(testImporters.sort(), [...NEW_TESTS].sort());
    for (const relative of NEW_MODULES) assert.equal(fs.existsSync(path.join(REPO_ROOT, relative)), true, relative);
});

test('the new modules take faults and trust through injection, never through environment variables or network', () => {
    for (const relative of NEW_MODULES) {
        const text = read(relative);
        assert.doesNotMatch(text, /process\.env/, relative);
        assert.doesNotMatch(text, /from ['"]node:(http|https|net|dgram|child_process)['"]/, relative);
        assert.doesNotMatch(text, /from ['"](http|https|net|dgram|child_process)['"]/, relative);
        // No new module imports existing lifecycle code that could wire it.
        const imports = [...text.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]).filter((specifier) => specifier.startsWith('.'));
        for (const specifier of imports) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
            assert.ok(NEW_MODULES.includes(target), `${relative} imports ${target}`);
        }
    }
});
