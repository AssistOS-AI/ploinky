import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_EXTENSIONS = new Set([
    '',
    '.cjs',
    '.css',
    '.html',
    '.js',
    '.json',
    '.mjs',
    '.sh',
    '.yaml',
    '.yml',
]);

function sourceFiles(relativeRoot) {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    const files = [];
    const visit = (absolutePath) => {
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(absolutePath)) visit(path.join(absolutePath, entry));
            return;
        }
        if (SOURCE_EXTENSIONS.has(path.extname(absolutePath))) files.push(absolutePath);
    };
    visit(absoluteRoot);
    return files;
}

const activeRuntimeFiles = [
    ...sourceFiles('Agent'),
    ...sourceFiles('bin'),
    ...sourceFiles('cli'),
    path.join(repoRoot, 'container/runtime-contract.mjs'),
    path.join(repoRoot, 'container/runtime-supervisor.mjs'),
];

function assertAbsent(files, pattern, description) {
    const matches = files.flatMap((file) => {
        const content = fs.readFileSync(file, 'utf8');
        return pattern.test(content) ? [path.relative(repoRoot, file)] : [];
    });
    assert.deepEqual(matches, [], `${description}: ${matches.join(', ')}`);
}

test('active runtime source contains no removed managed-gateway transport artifacts', () => {
    assert.ok(activeRuntimeFiles.length > 50, 'active runtime source inventory is unexpectedly small');
    assertAbsent(
        activeRuntimeFiles,
        /ploinky-network-gateway|NETWORK_GATEWAY_IMAGE|gatewayContainerName|ensureGateway|reconcileManagedControlPlane|io\.assistos\.ploinky\.resource[^\n]*gateway/,
        'removed gateway image or lifecycle symbol remains',
    );
    assertAbsent(activeRuntimeFiles, /router\.sock|managed-hosts/, 'removed socket or generated hosts artifact remains');
    assertAbsent(activeRuntimeFiles, /http:\/\/ploinky-router:8080/, 'removed fixed router URL remains');
});

test('active managed runtime source contains no slirp host-loopback fallback', () => {
    assertAbsent(
        activeRuntimeFiles,
        /slirp4netns:allow_host_loopback=true/,
        'managed runtime slirp host-loopback fallback remains',
    );
});
