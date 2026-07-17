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
    'tests',
    'webLibs',
    '.github',
    'package.json',
];
const normativeRoots = ['docs'];
const normativeFiles = ['README.md', 'container/README.md'];
const ignoredDirectories = new Set([
    path.join('docs', 'superpowers'),
]);
const ignoredFiles = new Set([
    path.join('tests', 'lastRun.results'),
]);

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

function collectFiles(relativePath) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!fs.existsSync(absolutePath)) return [];
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return [relativePath];
    const files = [];
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const child = path.join(relativePath, entry.name);
        if (entry.isDirectory() && !ignoredDirectories.has(child)) files.push(...collectFiles(child));
        else if (entry.isFile()) files.push(child);
    }
    return files;
}

function readTextFiles(paths) {
    return paths
        .flatMap(collectFiles)
        .filter((relativePath) => !ignoredFiles.has(relativePath))
        .map((relativePath) => ({
            relativePath,
            source: fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
        }));
}

test('runtime contract v5 executable and test paths contain no retired routing/publication call graph', () => {
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

test('outer supervisor contains no automatic replacement or rollback transaction', () => {
    const source = fs.readFileSync(
        path.join(repositoryRoot, 'container', 'runtime-supervisor.mjs'),
        'utf8',
    );
    const forbidden = [
        'replaceRuntimeTransaction',
        ['-roll', 'back-'].join(''),
        ['previous runtime ', 'restored'].join(''),
        "['rename', existing.instance",
    ];
    assert.deepEqual(
        forbidden.filter(token => source.includes(token)),
        [],
    );
});

test('coordinated edge apply has no missing-source fallback', () => {
    const source = fs.readFileSync(
        path.join(repositoryRoot, 'cli', 'services', 'edgeGeneration.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /readExact\([^)]*,\s*\{[^}]*\bfallback\s*:/s);
});

test('source-absence CI runs both suites and rejects any skipped or missing pass', () => {
    const workflow = fs.readFileSync(
        path.join(repositoryRoot, '.github', 'workflows', 'verify-runtime-v5-source-absence.yml'),
        'utf8',
    );
    assert.match(workflow, /node --test --test-reporter=tap/);
    assert.match(workflow, /tests\/unit\/runtimeV5SourceAbsence\.test\.mjs/);
    assert.match(workflow, /tests\/unit\/networkHardCutSourceAbsence\.test\.mjs/);
    for (const expectation of [
        'require_summary tests 7',
        'require_summary pass 7',
        'require_summary fail 0',
        'require_summary cancelled 0',
        'require_summary skipped 0',
        'require_summary todo 0',
    ]) {
        assert.ok(workflow.includes(expectation), `workflow is missing exact TAP guard: ${expectation}`);
    }
});
