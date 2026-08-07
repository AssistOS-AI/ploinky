import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const executableRoots = [
    'Agent',
    'bin',
    'cli',
    'container',
    'dashboard',
    'globalDeps',
    'ploinky-box',
    'tests',
    'webLibs',
    '.github',
    'package.json',
];
const normativeRoots = ['docs'];
const normativeFiles = ['README.md', 'container/README.md'];
const activeBoxDocumentation = [
    'docs/architecture.html',
    'docs/cli-reference.html',
    'docs/code-derived-agent-lifecycle.md',
    'docs/http-route-access-security-model.md',
    'docs/operations.html',
    'docs/runtime.html',
    'docs/spec-agent.html',
];

const legacyRuntimeTokens = [
    ['additional', 'ServerPort'].join(''),
    ['profile', 'Server'].join(''),
    ['profile', '-server'].join(''),
    ['box', 'PublicationCoverage'].join(''),
    ['box', 'StartPublishPlan'].join(''),
    ['publication', 'PreflightComplete'].join(''),
    ['PLOINKY_OUTER_', 'PUBLICATION_CONTRACT'].join(''),
    ['PLOINKY_OUTER_', 'PUBLICATION_REQUIRED'].join(''),
];

const removedComponentPatterns = [
    new RegExp(['web', 'publishing'].join('-'), 'i'),
    new RegExp(['basic', 'cloudflared'].join('/'), 'i'),
    new RegExp(['cloudflared', 'agent'].join('-'), 'i'),
    new RegExp(['standalone', 'cloudflared'].join('[-_ ]+'), 'i'),
    new RegExp(['WEB', 'PUBLISHING_'].join('_')),
    new RegExp(['ONLYOFFICE_', 'PUBLIC_URL'].join('')),
    new RegExp(['ONLYOFFICE_', 'INTERNAL_URL'].join('')),
    new RegExp(['ONLYOFFICE_', 'CALLBACK_BASE_URL'].join('')),
    new RegExp(['WEBMEET_', '[A-Z0-9_]*', 'LIVEKIT'].join('')),
    new RegExp(['WEBMEET_', 'TURN_'].join('')),
    new RegExp(['WEBMEET_', 'TLS_HOSTNAME'].join('')),
    new RegExp(['WEBMEET_', 'CERT_EMAIL'].join('')),
    new RegExp(['WEBDASHBOARD', '_TOKEN'].join('')),
];

const retiredBoxVersionTokens = [
    ['io.assistos.ploinky', 'runtime-contract'].join('.'),
    ['io.assistos.ploinky', 'identity-schema'].join('.'),
    ['io.assistos.ploinky-box', 'schema'].join('.'),
    ['BOX', 'SCHEMA', 'VERSION'].join('_'),
    ['BOX', 'RUNTIME', 'CONTRACT'].join('_'),
    ['RUNTIME', 'CONTRACT', 'LABEL'].join('_'),
    ['REQUIRED', 'RUNTIME', 'CONTRACT'].join('_'),
    ['IDENTITY', 'SCHEMA', 'VERSION'].join('_'),
    ['PLOINKY_BOX_READY ', 'contract='].join(''),
    ['.ploinky-box-dependencies-', 'v6.json'].join(''),
    ['runtime', 'V5'].join(''),
    ['runtime-', 'v5'].join(''),
    ['full-explorer-', 'v5'].join(''),
    ['routing-graph-', 'v5'].join(''),
    ['contract-', '5'].join(''),
    ['contract-', '6'].join(''),
    ['contract ', '5'].join(''),
    ['contract ', '6'].join(''),
    ['Contract-', '5'].join(''),
    ['Contract ', '4'].join(''),
    ['contract:', ' compatible (expected 5'].join(''),
];

function collectFiles(relativePath) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!fs.existsSync(absolutePath)) return [];
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return [relativePath];
    const files = [];
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git'
            || (relativePath === 'docs' && entry.name === 'superpowers')) continue;
        const child = path.join(relativePath, entry.name);
        if (entry.isDirectory()) files.push(...collectFiles(child));
        else if (entry.isFile()) files.push(child);
    }
    return files;
}

function readTextFiles(paths) {
    return paths
        .flatMap(collectFiles)
        .map((relativePath) => ({
            relativePath,
            source: fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
        }));
}

test('managed runtime executable and test paths contain no retired routing/publication call graph', () => {
    const violations = [];
    for (const file of readTextFiles(executableRoots)) {
        for (const token of legacyRuntimeTokens) {
            if (file.relativePath.includes(token) || file.source.includes(token)) {
                violations.push(`${file.relativePath}: ${token}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('removed publication component and consumer variables are absent from active and normative paths', () => {
    const violations = [];
    const files = readTextFiles([...executableRoots, ...normativeRoots, ...normativeFiles]);
    for (const file of files) {
        for (const pattern of removedComponentPatterns) {
            if (pattern.test(file.relativePath) || pattern.test(file.source)) {
                violations.push(`${file.relativePath}: ${pattern.source}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('active Box paths contain no numeric contract, schema, marker, ready-line, helper, or profile version', () => {
    const violations = [];
    const files = readTextFiles([
        ...executableRoots,
        ...normativeFiles,
        ...activeBoxDocumentation,
    ]);
    for (const file of files) {
        const normalizedPath = file.relativePath.toLowerCase();
        const normalizedSource = file.source.toLowerCase();
        for (const token of retiredBoxVersionTokens) {
            const normalizedToken = token.toLowerCase();
            if (normalizedPath.includes(normalizedToken)
                || normalizedSource.includes(normalizedToken)) {
                violations.push(`${file.relativePath}: ${token}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('retired Box version detection is case-insensitive', () => {
    const variants = [
        ['Contract', '-6'].join(''),
        ['Runtime', '-v5'].join(''),
        ['PLOINKY_BOX_READY ', 'Contract=6'].join(''),
    ];
    for (const variant of variants) {
        assert.equal(
            retiredBoxVersionTokens.some((token) => (
                variant.toLowerCase().includes(token.toLowerCase())
            )),
            true,
            variant,
        );
    }
});

test('retired outer runtime implementation is absent', () => {
    const retired = [
        'container/runtime-contract.mjs',
        'container/runtime-engine.mjs',
        'container/runtime-supervisor.mjs',
        'container/runtime-supervisor-tests.mjs',
        'container/smoke-runtime.mjs',
        'tests/helpers/runtimeSupervisorHarness.mjs',
        'tests/unit/runtimeSupervisor.test.mjs',
        'tests/unit/smokeFullGraphPrerequisites.test.mjs',
    ];
    assert.deepEqual(retired.filter(relativePath => (
        fs.existsSync(path.join(repositoryRoot, relativePath))
    )), []);
});

test('coordinated edge apply has no missing-source fallback', () => {
    const source = fs.readFileSync(
        path.join(repositoryRoot, 'cli', 'sandbox', 'edgeGeneration.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /readExact\([^)]*,\s*\{[^}]*\bfallback\s*:/s);
});

test('source-absence CI runs both suites and rejects any skipped or missing pass', () => {
    const workflow = fs.readFileSync(
        path.join(repositoryRoot, '.github', 'workflows', 'verify-runtime-source-absence.yml'),
        'utf8',
    );
    assert.match(workflow, /node --test --test-reporter=tap/);
    assert.match(workflow, /tests\/unit\/runtimeSourceAbsence\.test\.mjs/);
    assert.match(workflow, /tests\/unit\/networkHardCutSourceAbsence\.test\.mjs/);
    for (const expectation of [
        'require_summary tests 9',
        'require_summary pass 9',
        'require_summary fail 0',
        'require_summary cancelled 0',
        'require_summary skipped 0',
        'require_summary todo 0',
    ]) {
        assert.ok(workflow.includes(expectation), `workflow is missing exact TAP guard: ${expectation}`);
    }
});
