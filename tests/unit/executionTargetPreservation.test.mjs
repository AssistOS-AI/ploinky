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
    'cli/server/executionTarget/discovery.mjs',
    'cli/server/security/tokens/targetHelperTicketMinter.mjs',
    'cli/server/executionTarget/sourceProtectionService.mjs',
    'cli/utils/runtime/sourceProtectionGate.mjs',
    'cli/utils/runtime/sourceProtectionStore.mjs',
    'cli/utils/runtime/sourceProtectionInterlock.mjs',
    'cli/sandbox/legacyAgentAdoptionGuard.mjs',
    'cli/server/executionTarget/provisioning.mjs',
    'cli/server/executionTarget/liveScope.mjs',
    'cli/server/executionTarget/helperTicketSecrets.mjs',
    'cli/server/executionTarget/workerMailbox.mjs',
    'cli/server/executionTarget/helperTicketService.mjs',
]);
const NEW_TESTS = Object.freeze([
    'tests/unit/executionTargetDeclaration.test.mjs',
    'tests/unit/executionTargetSourceProtection.test.mjs',
    'tests/unit/legacyAgentAdoptionGuard.test.mjs',
    'tests/unit/executionTargetPreservation.test.mjs',
    'tests/unit/executionTargetCommonVectors.test.mjs',
    'tests/unit/executionTargetDiscovery.test.mjs',
    'tests/unit/executionTargetHelperTicket.test.mjs',
    'tests/unit/executionTargetSourceProtectionWiring.test.mjs',
    'tests/unit/legacyAgentMaskCompleteness.test.mjs',
    'tests/unit/executionTargetProvisioning.test.mjs',
    'tests/unit/executionTargetLiveScope.test.mjs',
    'tests/unit/executionTargetHelperTicketSecrets.test.mjs',
    'tests/unit/executionTargetWorkerMailbox.test.mjs',
    'tests/unit/executionTargetHelperTicketRoute.test.mjs',
]);
// The pure guard names the legacy markers only to detect them.
const GUARD = 'cli/sandbox/legacyAgentAdoptionGuard.mjs';

// `contract` and `declaration` are common words; `discovery` appears in unrelated production code (model and agent
// discovery). The `executionTarget/` path test and the exported operation names still catch a real importer of them.
const BASENAME_EXEMPT = new Set(['contract', 'declaration', 'discovery', 'provisioning']);

// P3: the one start-boundary call site of target provisioning. It imports exactly these three names and nothing else
// of the new modules; `planExecutionTargetLaunch` is null for every manifest without the `executionTarget` key.
const PROVISIONING_CALL_SITE = Object.freeze({
    file: 'cli/sandbox/docker/agentServiceManager.js',
    line: "import { planExecutionTargetLaunch, provisionExecutionTarget, JOURNAL_INIT_TIMEOUT_MS, TARGET_RUNTIME_ROOT } from '../../server/executionTarget/provisioning.mjs';",
    // The worker-mailbox grant (one start-boundary decision, the mailbox-root bind) and the exact-instance mailbox
    // retirement after a proven removal. The local grant variable carries the module's basename.
    workerMailboxLine: "import { ensureMailboxRoot, planWorkerMailboxGrant, retireInstanceMailboxes, WORKER_TARGETS_PATH } from '../../server/executionTarget/workerMailbox.mjs';",
    workerMailboxCalls: Object.freeze({ planWorkerMailboxGrant: 1, retireInstanceMailboxes: 1, ensureMailboxRoot: 1 }),
    workerMailboxVariable: 'workerMailboxGrant',
});

// P5: the one Router call site of the private source-protection operation. privateRouter.js imports exactly these two
// modules of the new tree (the service and the live-scope provider), calls each exactly once, and RoutingServer.js
// reaches them only through its `sendSourceProtection` import (pinned by the wiring test).
// P4 mint route (2026-10-30): the one Router call site of the private helper-ticket operation adds exactly three imports
// (the helper-ticket service with its store-pointer reader, the ticket-secret provider and the provisioning helper-facts
// reader), each name called exactly once in the readers of `sendTargetHelperTicket`; RoutingServer.js reaches it only
// through its `sendTargetHelperTicket` import (pinned by the route test).
const ROUTER_GLUE = Object.freeze({
    file: 'cli/server/privateRouter.js',
    imports: Object.freeze([
        "import { createLiveBoxScopeProvider } from './executionTarget/liveScope.mjs';",
        "import { createSourceProtectionService } from './executionTarget/sourceProtectionService.mjs';",
        "import { createHelperTicketService, readWorkerGenerationPointer } from './executionTarget/helperTicketService.mjs';",
        "import { createHelperTicketSecretProvider } from './executionTarget/helperTicketSecrets.mjs';",
        "import { readExecutionTargetHelperFacts } from './executionTarget/provisioning.mjs';",
    ]),
    // The injected live-scope key of the service call; the provider is the Router's own wrapper around the module's.
    liveScopeKey: 'liveScope: createRouterLiveScope(',
    // The helper-ticket readers: each new-tree name is called once.
    helperTicketCalls: Object.freeze({
        createHelperTicketService: 1, readWorkerGenerationPointer: 1, createHelperTicketSecretProvider: 1, readExecutionTargetHelperFacts: 1,
    }),
});

// P5: the reviewed lifecycle call sites of the source-protection gate. Each imports exactly the synchronous
// `assertSourceSetFixed` and nothing else of the new modules; the gate is inert for a workspace without a store.
const GATE_CALL_SITES = Object.freeze({
    'cli/utils/repos.js': "import { assertSourceSetFixed } from './runtime/sourceProtectionGate.mjs';",
    'cli/utils/linkInstall.mjs': "import { assertSourceSetFixed } from './runtime/sourceProtectionGate.mjs';",
    'cli/utils/workspaceStructure.js': "import { assertSourceSetFixed } from './runtime/sourceProtectionGate.mjs';",
});

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

test('T1-10 / T1-11 the new generic modules have no production importer except the reviewed gate and provisioning call sites, and register no route', () => {
    const newNames = NEW_MODULES.map((relative) => path.basename(relative, '.mjs'));
    const operationNames = [
        'reserveWritableResources', 'prepareSourceTransition', 'releaseWritableReservation', 'acknowledgeSourceStore',
        'advanceWorkerGeneration', 'openSourceProtectionStore', 'createSourceProtectionInterlock',
        'evaluateLegacyAgentAdoption', 'evaluateInterimLegacyMarkers', 'validateExecutionTargetDeclaration',
        'readExecutionTargetDeclaration', 'discoverExecutionTargets', 'createTargetHelperTicketMinter',
        'planWorkerMailboxGrant', 'retireInstanceMailboxes', 'ensureMailboxRoot',
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
        if (relative === PROVISIONING_CALL_SITE.file) {
            assert.deepEqual(text.match(/^import .*executionTarget\/.*$/gm),
                [PROVISIONING_CALL_SITE.line, PROVISIONING_CALL_SITE.workerMailboxLine], relative);
            // Two reviewed plan sites: the start boundary, and the refusal of identity-preserving targeted restarts.
            assert.equal(text.match(/\bplanExecutionTargetLaunch\(/g).length, 2, relative);
            assert.equal(text.match(/if \(targetedRestart && planExecutionTargetLaunch\(\{ manifest,/g)?.length, 1, relative);
            assert.equal(text.match(/\bprovisionExecutionTarget\(/g).length, 1, relative);
            text = text.replaceAll(PROVISIONING_CALL_SITE.line, '').replaceAll(PROVISIONING_CALL_SITE.workerMailboxLine, '');
            for (const [name, count] of Object.entries(PROVISIONING_CALL_SITE.workerMailboxCalls)) {
                assert.equal(text.match(new RegExp(`\\b${name}\\(`, 'g'))?.length, count, `${relative} ${name}`);
                text = text.replaceAll(name, '');
            }
            text = text.replaceAll(PROVISIONING_CALL_SITE.workerMailboxVariable, '');
        }
        if (relative === ROUTER_GLUE.file) {
            assert.deepEqual(text.match(/^import .*executionTarget\/.*$/gm), ROUTER_GLUE.imports, relative);
            assert.equal(text.match(/\bcreateSourceProtectionService\(/g).length, 1, relative);
            assert.equal(text.match(/\bcreateLiveBoxScopeProvider\(/g).length, 1, relative);
            // Two uses: the source-protection service and the helper-ticket readers (deliberately updated from 1).
            assert.equal(text.split(ROUTER_GLUE.liveScopeKey).length - 1, 2, relative);
            for (const line of ROUTER_GLUE.imports) text = text.replaceAll(line, '');
            text = text.replaceAll('createSourceProtectionService(', '').replaceAll('createLiveBoxScopeProvider(', '')
                .replaceAll(ROUTER_GLUE.liveScopeKey, 'createRouterLiveScope(');
            for (const [name, count] of Object.entries(ROUTER_GLUE.helperTicketCalls)) {
                assert.equal(text.match(new RegExp(`\\b${name}\\(`, 'g'))?.length, count, `${relative} ${name}`);
                text = text.replaceAll(name, '');
            }
        }
        if (Object.hasOwn(GATE_CALL_SITES, relative)) {
            assert.deepEqual(text.match(/^import .*sourceProtectionGate.*$/gm), [GATE_CALL_SITES[relative]], relative);
            assert.equal(text.match(/\bassertSourceSetFixed\(/g).length >= 1, true, relative);
            text = text.replaceAll(GATE_CALL_SITES[relative], '');
        }
        // Nothing in production may switch the full predicate on per call.
        if (text.includes('legacyAgentLifecycleGuard')) assert.doesNotMatch(text, /\bactive:\s*true\b/, relative);
        // A sibling inside executionTarget/ (or anywhere) importing the exempt-named modules by specifier is an importer.
        if (/['"][^'"]*\btargetHelperTicketMinter\.mjs['"]/.test(text)) importers.push(relative);
        // ploinky-box has its own unrelated engine/discovery.mjs, so the bare specifier is only checked beside the module.
        if (relative.startsWith('cli/server/executionTarget/') && /['"]\.\/discovery\.mjs['"]/.test(text)) importers.push(relative);
        if (/executionTarget\//.test(text) || newNames.some((name) => !BASENAME_EXEMPT.has(name) && text.includes(name))) {
            importers.push(relative);
        }
        if (operationNames.some((name) => text.includes(name))) importers.push(relative);
    }
    assert.deepEqual([...new Set(importers)], []);
    // Among tests, only the new T1 tests reach them.
    const testImporters = [...files('tests')].filter((relative) => (
        !relative.startsWith('tests/unit/fixtures/')
        && (/executionTarget\/|sourceProtection(Store|Interlock)|legacyAgentAdoptionGuard|targetHelperTicketMinter/.test(read(relative)))
    ));
    assert.deepEqual(testImporters.sort(), [...NEW_TESTS].sort());
    for (const relative of NEW_MODULES) assert.equal(fs.existsSync(path.join(REPO_ROOT, relative)), true, relative);
});

test('P5 the Router glue names have exactly one production caller: RoutingServer.js through its reviewed import', () => {
    const names = /\b(sendSourceProtection|createRouterLiveScope|sendTargetHelperTicket|targetHelperTicketReaders)\b/;
    assert.deepEqual(productionFiles().filter((relative) => names.test(read(relative))).sort(), [
        'cli/server/RoutingServer.js', 'cli/server/privateRouter.js',
    ]);
    const router = read('cli/server/RoutingServer.js');
    assert.deepEqual(router.match(/^import .*sendSourceProtection.*$/gm), ["import { sendSourceProtection } from './privateRouter.js';"]);
    assert.equal(router.match(/\bsendSourceProtection\(/g).length, 1);
    assert.doesNotMatch(router, /createRouterLiveScope/);
    // The helper-ticket operation: one bottom import and one call, no reader composition in RoutingServer.js.
    assert.deepEqual(router.match(/^import .*sendTargetHelperTicket.*$/gm), ["import { sendTargetHelperTicket } from './privateRouter.js';"]);
    assert.equal(router.match(/\bsendTargetHelperTicket\(/g).length, 1);
    assert.doesNotMatch(router, /targetHelperTicketReaders|helperTicketService|createHelperTicket/);
    // privateRouter.js: the definitions, the two uses of the live-scope provider (source protection and the
    // helper-ticket readers; deliberately updated from one) and the default-export entries.
    const glue = read(ROUTER_GLUE.file);
    assert.equal(glue.match(/\bsendSourceProtection\b/g).length, 2);
    assert.equal(glue.match(/\bcreateRouterLiveScope\b/g).length, 3);
    assert.equal(glue.match(/\bsendTargetHelperTicket\b/g).length, 2);
    assert.equal(glue.match(/\btargetHelperTicketReaders\b/g).length, 2);
    assert.match(glue, /^export async function sendSourceProtection\(/m);
    assert.match(glue, /^export function createRouterLiveScope\(/m);
    assert.match(glue, /^export async function sendTargetHelperTicket\(/m);
    assert.match(glue, /^function targetHelperTicketReaders\(/m);
});

test('P5 the agent-side source-protection transport is a library for worker hosts: no production file imports it', () => {
    const transport = 'Agent/lib/sourceProtectionTransport.mjs';
    assert.equal(fs.existsSync(path.join(REPO_ROOT, transport)), true);
    const importers = productionFiles().filter((relative) => relative !== transport && read(relative).includes('sourceProtectionTransport'));
    assert.deepEqual(importers, []);
    const text = read(transport);
    assert.doesNotMatch(text, /executionTarget\/|sourceProtection(Store|Interlock|Gate|Service)/);
});

test('P4 the agent-side helper-ticket transport is a library for worker hosts: no production file imports it', () => {
    const transport = 'Agent/lib/helperTicketTransport.mjs';
    assert.equal(fs.existsSync(path.join(REPO_ROOT, transport)), true);
    const importers = productionFiles().filter((relative) => relative !== transport && read(relative).includes('helperTicketTransport'));
    assert.deepEqual(importers, []);
    const text = read(transport);
    assert.doesNotMatch(text, /executionTarget\/|targetHelperTicketMinter|helperTicketService|helperTicketSecrets/);
    // One request of at most 64 KiB each way; no retry loop and no cache.
    assert.match(text, /^const MAX_REQUEST_BYTES = 64 \* 1024;$/m);
    assert.match(text, /^const MAX_RESPONSE_BYTES = 64 \* 1024;$/m);
    assert.equal(text.match(/\brequestOnce\(/g).length, 2, 'one definition, one call');
    assert.doesNotMatch(text, /\bnew Map\(|\bwhile \(|\bfor \(/);
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
