import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkBoundary } from '../../ploinky-box/boundary/checkBoundary.mjs';
import {
    fingerprintPath,
    sha256,
} from '../../ploinky-box/boundary/fingerprint.mjs';
import { readDirtyEntries } from '../../ploinky-box/boundary/gitState.mjs';
import { BoundaryViolationError } from '../../ploinky-box/errors.mjs';

const PROTECTED_HISTORY_PATH = 'docs/design-history/original.md';
const RUNTIME_PATH = 'docs/runtime.html';
const PROTECTED_PARAGRAPH = '<p>Default rootless Podman containers use pasta; '
    + 'on macOS the host alias remains available.</p>';
let fixtureSequence = 0;

function git(repositoryRoot, args) {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function writeRepositoryFile(repositoryRoot, relativePath, content, mode = 0o644) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, { mode });
    fs.chmodSync(absolutePath, mode);
}

function runtimeDocument(ownerParagraph = '') {
    return [
        '<main>',
        '  <section class="chapter-section">',
        '    <h2>Runtime Backends and Mount Policy</h2>',
        `    ${PROTECTED_PARAGRAPH}`,
        '  </section>',
        '  <section class="chapter-section">',
        '    <h2>Operations</h2>',
        '    <p>Existing content.</p>',
        '  </section>',
        ownerParagraph,
        '</main>',
        '',
    ].filter((line) => line !== '').join('\n') + '\n';
}

function captureFixtureManifest(repositoryRoot, baseSha, allowlist) {
    const manifestPath = path.join(repositoryRoot, '.git', 'ploinky-box-baseline.json');
    const snapshotPath = path.join(
        repositoryRoot,
        '.git',
        'ploinky-box-docs-runtime.snapshot.html',
    );
    const runtimeBytes = fs.readFileSync(path.join(repositoryRoot, RUNTIME_PATH));
    fs.writeFileSync(snapshotPath, runtimeBytes, { mode: 0o600 });
    fs.chmodSync(snapshotPath, 0o600);

    const dirtyFiles = readDirtyEntries(repositoryRoot).map((entry) => ({
        ...entry,
        classification: entry.path === RUNTIME_PATH
            ? 'editable-with-protected-baseline'
            : 'protected',
        ...fingerprintPath(repositoryRoot, entry.path),
        ...(entry.originalPath
            ? { original: fingerprintPath(repositoryRoot, entry.originalPath) }
            : {}),
    })).sort((left, right) => left.path.localeCompare(right.path));
    const paragraphBytes = Buffer.from(PROTECTED_PARAGRAPH);
    const manifest = {
        kind: 'ploinky-box-boundary-baseline',
        repositoryRoot: fs.realpathSync(repositoryRoot),
        baseSha,
        baseCommitVerified: true,
        branch: git(repositoryRoot, ['branch', '--show-current']).trim(),
        allowlist,
        dirtyFiles,
        originalPlan: {
            path: PROTECTED_HISTORY_PATH,
            gitBlobHash: git(repositoryRoot, ['hash-object', PROTECTED_HISTORY_PATH]).trim(),
            ...fingerprintPath(repositoryRoot, PROTECTED_HISTORY_PATH),
        },
        editableBaseline: {
            path: RUNTIME_PATH,
            snapshotPath,
            snapshotMode: '100600',
            snapshotSha256: sha256(runtimeBytes),
            protectedParagraphBase64: paragraphBytes.toString('base64'),
            protectedParagraphSha256: sha256(paragraphBytes),
        },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
    });
    return manifestPath;
}

function createFixture(t) {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-boundary-'));
    fixtureSequence += 1;
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));

    git(repositoryRoot, ['init', '-q']);
    git(repositoryRoot, ['config', 'user.email', 'test@example.com']);
    git(repositoryRoot, ['config', 'user.name', 'Ploinky Box Test']);
    writeRepositoryFile(repositoryRoot, RUNTIME_PATH, runtimeDocument());
    writeRepositoryFile(repositoryRoot, PROTECTED_HISTORY_PATH, 'original plan\n');
    writeRepositoryFile(repositoryRoot, 'protected.txt', 'committed content\n');
    writeRepositoryFile(repositoryRoot, 'fixture-id.txt', `${fixtureSequence}\n`);
    writeRepositoryFile(repositoryRoot, 'tests/unit/existing.test.mjs', 'export const value = 1;\n');
    writeRepositoryFile(repositoryRoot, 'legacy.txt', 'rename source\n');
    writeRepositoryFile(repositoryRoot, 'ploinky-box/old.txt', 'allowed rename source\n');
    git(repositoryRoot, ['add', '.']);
    git(repositoryRoot, ['commit', '-q', '-m', 'baseline']);
    const baseSha = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();

    writeRepositoryFile(repositoryRoot, 'protected.txt', 'owner content\n');
    writeRepositoryFile(repositoryRoot, PROTECTED_HISTORY_PATH, 'owner original plan\n');
    writeRepositoryFile(
        repositoryRoot,
        RUNTIME_PATH,
        runtimeDocument('  <p>Owner runtime paragraph.</p>'),
    );

    const allowlist = [
        'ploinky-box/**',
        'tests/unit/ploinkyBox*.test.mjs',
        'docs/runtime.html',
        PROTECTED_HISTORY_PATH,
    ];
    const manifestPath = captureFixtureManifest(repositoryRoot, baseSha, allowlist);
    return {
        allowlist,
        baseSha,
        manifestPath,
        repositoryRoot,
    };
}

function checkFixture(fixture) {
    return checkBoundary(
        fixture.repositoryRoot,
        fixture.baseSha,
        fixture.allowlist,
        fixture.manifestPath,
    );
}

function assertBoundaryViolation(callback, messagePattern) {
    assert.throws(callback, (error) => {
        assert.ok(error instanceof BoundaryViolationError);
        if (messagePattern) {
            assert.match(error.message, messagePattern);
        }
        return true;
    });
}

test('boundary accepts unchanged protected dirt and an allowed untracked Box test', (t) => {
    const fixture = createFixture(t);
    writeRepositoryFile(
        fixture.repositoryRoot,
        'tests/unit/ploinkyBoxAllowed.test.mjs',
        'export const allowed = true;\n',
    );

    const result = checkFixture(fixture);

    assert.deepEqual(result.implementationPaths, [
        'tests/unit/ploinkyBoxAllowed.test.mjs',
    ]);
    assert.ok(result.protectedPaths.includes('protected.txt'));
    assert.deepEqual(result.editablePaths, [RUNTIME_PATH]);
});

test('boundary rejects an untracked cli file and an existing test modification', async (t) => {
    await t.test('untracked cli file', (subtest) => {
        const fixture = createFixture(subtest);
        writeRepositoryFile(fixture.repositoryRoot, 'cli/unplanned.mjs', 'export {};\n');

        assertBoundaryViolation(
            () => checkFixture(fixture),
            /cli\/unplanned\.mjs/,
        );
    });

    await t.test('existing test modification', (subtest) => {
        const fixture = createFixture(subtest);
        writeRepositoryFile(
            fixture.repositoryRoot,
            'tests/unit/existing.test.mjs',
            'export const value = 2;\n',
        );

        assertBoundaryViolation(
            () => checkFixture(fixture),
            /tests\/unit\/existing\.test\.mjs/,
        );
    });
});

test('boundary requires both sides of a rename to be authorized', async (t) => {
    await t.test('rejects a disallowed source', (subtest) => {
        const fixture = createFixture(subtest);
        fs.renameSync(
            path.join(fixture.repositoryRoot, 'legacy.txt'),
            path.join(fixture.repositoryRoot, 'ploinky-box', 'renamed.txt'),
        );

        assertBoundaryViolation(() => checkFixture(fixture), /legacy\.txt/);
    });

    await t.test('accepts two allowed sides', (subtest) => {
        const fixture = createFixture(subtest);
        fs.renameSync(
            path.join(fixture.repositoryRoot, 'ploinky-box', 'old.txt'),
            path.join(fixture.repositoryRoot, 'ploinky-box', 'renamed.txt'),
        );

        const result = checkFixture(fixture);
        assert.deepEqual(result.implementationPaths, [
            'ploinky-box/old.txt',
            'ploinky-box/renamed.txt',
        ]);
    });
});

test('boundary rejects protected-history content and mode changes', async (t) => {
    await t.test('content', (subtest) => {
        const fixture = createFixture(subtest);
        writeRepositoryFile(
            fixture.repositoryRoot,
            PROTECTED_HISTORY_PATH,
            'changed after capture\n',
        );

        assertBoundaryViolation(() => checkFixture(fixture), /Protected dirty content or mode/);
    });

    await t.test('mode', (subtest) => {
        const fixture = createFixture(subtest);
        fs.chmodSync(path.join(fixture.repositoryRoot, PROTECTED_HISTORY_PATH), 0o755);

        assertBoundaryViolation(() => checkFixture(fixture), /Protected dirty content or mode/);
    });
});

test('boundary rejects broad documentation changes', (t) => {
    const fixture = createFixture(t);
    writeRepositoryFile(fixture.repositoryRoot, 'docs/unplanned.html', '<p>no</p>\n');

    assertBoundaryViolation(() => checkFixture(fixture), /docs\/unplanned\.html/);
});

test('boundary accepts one separate insertion-only Ploinky Box section', (t) => {
    const fixture = createFixture(t);
    const runtimePath = path.join(fixture.repositoryRoot, RUNTIME_PATH);
    const baseline = fs.readFileSync(runtimePath, 'utf8');
    const boxSection = [
        '  <section class="chapter-section">',
        '    <h2>Ploinky Box</h2>',
        '    <p>Box behavior.</p>',
        '  </section>',
        '',
    ].join('\n');
    fs.writeFileSync(
        runtimePath,
        baseline.replace(
            '  <section class="chapter-section">\n    <h2>Operations</h2>',
            `${boxSection}  <section class="chapter-section">\n    <h2>Operations</h2>`,
        ),
    );

    const result = checkFixture(fixture);

    assert.deepEqual(result.editablePaths, [RUNTIME_PATH]);
    assert.deepEqual(result.implementationPaths, []);
});

test('boundary rejects protected paragraph edits and baseline replacement', async (t) => {
    await t.test('protected paragraph byte change', (subtest) => {
        const fixture = createFixture(subtest);
        const runtimePath = path.join(fixture.repositoryRoot, RUNTIME_PATH);
        const baseline = fs.readFileSync(runtimePath, 'utf8');
        fs.writeFileSync(runtimePath, baseline.replace('pasta', 'Pasta'));

        assertBoundaryViolation(() => checkFixture(fixture), /protected rootless-Podman paragraph/);
    });

    await t.test('baseline replacement', (subtest) => {
        const fixture = createFixture(subtest);
        const runtimePath = path.join(fixture.repositoryRoot, RUNTIME_PATH);
        const baseline = fs.readFileSync(runtimePath, 'utf8');
        fs.writeFileSync(
            runtimePath,
            baseline.replace('Existing content.', 'Replacement content.'),
        );

        assertBoundaryViolation(() => checkFixture(fixture), /one insertion only/);
    });
});

test('boundary binds each manifest to its own repository and base', (t) => {
    const first = createFixture(t);
    const second = createFixture(t);

    assert.doesNotThrow(() => checkFixture(first));
    assert.doesNotThrow(() => checkFixture(second));
    assertBoundaryViolation(
        () => checkBoundary(
            first.repositoryRoot,
            second.baseSha,
            first.allowlist,
            first.manifestPath,
        ),
        /Base SHA does not match/,
    );
    assertBoundaryViolation(
        () => checkBoundary(
            second.repositoryRoot,
            first.baseSha,
            second.allowlist,
            second.manifestPath,
        ),
        /Base SHA does not match/,
    );
});
