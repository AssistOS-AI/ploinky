import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    LOCKED_ROOT_POSTINSTALL,
    defaultPaths,
    parseCommandLine,
    parseExactGitCommitSpec,
    readBoundedJsonFile,
    validateAgentlibDeliveryMetadata,
    validateReleaseManifest,
    validateRootPackageInstaller,
    verifyReleaseBundle,
} from '../release/verifyCopilot421Bundle.mjs';

const SHAS = Object.freeze({
    achillesAgentLib: '1'.repeat(40),
    ploinky: '2'.repeat(40),
    achillesCLI: '3'.repeat(40),
    explorer: '4'.repeat(40),
});
const BOX_DIGEST = `sha256:${'5'.repeat(64)}`;

function manifest() {
    return {
        repositories: Object.fromEntries(Object.entries(SHAS).map(([name, commit]) => (
            [name, { commit }]
        ))),
        images: {
            ploinkyBox: { digest: BOX_DIGEST },
        },
    };
}

// achillesAgentLib is direct-mounted from the selected workspace source, so a
// release bundle's globalDeps must install mcp-sdk only.
function globalPackage({ declaresAgentLib = false } = {}) {
    return {
        dependencies: {
            'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
            ...(declaresAgentLib
                ? { achillesAgentLib: 'git+https://github.com/AssistOS-AI/achillesAgentLib.git' }
                : {}),
        },
    };
}

function dependencyLock(commit = SHAS.achillesAgentLib) {
    return {
        repositories: {
            achillesAgentLib: {
                url: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
                commit,
            },
        },
    };
}

function rootPackage(postinstall = LOCKED_ROOT_POSTINSTALL) {
    return {
        scripts: { postinstall },
    };
}

function verificationFixture({ states = {} } = {}) {
    const paths = {
        achillesAgentLib: '/fixture/agentlib',
        ploinky: '/fixture/ploinky',
        achillesCLI: '/fixture/achillescli',
        explorer: '/fixture/explorer',
        rootPackage: '/fixture/package.json',
        globalPackage: '/fixture/globalDeps/package.json',
        dependencyLock: '/fixture/ploinky-box/dependencies.lock.json',
    };
    const stateByPath = Object.fromEntries(Object.entries(SHAS).map(([name, head]) => [
        paths[name],
        { head, clean: true, ...(states[name] || {}) },
    ]));
    return {
        paths,
        readJson(filePath) {
            if (filePath === paths.rootPackage) return rootPackage();
            if (filePath === paths.globalPackage) return globalPackage();
            if (filePath === paths.dependencyLock) return dependencyLock();
            throw new Error(`unexpected fixture path ${filePath}`);
        },
        inspectRepository(repositoryPath) {
            return stateByPath[repositoryPath];
        },
    };
}

test('release verifier accepts one complete, exact immutable bundle', () => {
    const result = verifyReleaseBundle(manifest(), verificationFixture());
    assert.equal(result.imageDigest, BOX_DIGEST);
    assert.deepEqual(
        Object.fromEntries(Object.entries(result.repositories).map(([name, state]) => (
            [name, state.commit]
        ))),
        SHAS,
    );
});

test('release verifier paths pin the deployed repositories without nesting AgentLib in Ploinky', () => {
    const paths = defaultPaths('/candidate/ploinky', {
        env: {
            PLOINKY_RELEASE_AGENTLIB_DIR: '/workspace/achillesAgentLib',
            PLOINKY_RELEASE_ACHILLESCLI_DIR: '/workspace/.ploinky/repos/AchillesCLI',
            PLOINKY_RELEASE_EXPLORER_DIR: '/workspace/.ploinky/repos/AchillesIDE',
        },
    });
    assert.equal(paths.ploinky, '/candidate/ploinky');
    assert.equal(paths.achillesAgentLib, '/workspace/achillesAgentLib');
    assert.equal(paths.achillesCLI, '/workspace/.ploinky/repos/AchillesCLI');
    assert.equal(paths.explorer, '/workspace/.ploinky/repos/AchillesIDE');
});

test('release verifier repository pins are exact absolute paths', () => {
    for (const [name, value] of [
        ['PLOINKY_RELEASE_AGENTLIB_DIR', 'relative/achillesAgentLib'],
        ['PLOINKY_RELEASE_ACHILLESCLI_DIR', ' /workspace/.ploinky/repos/AchillesCLI'],
        ['PLOINKY_RELEASE_EXPLORER_DIR', '/workspace/.ploinky/repos/AchillesIDE '],
    ]) {
        assert.throws(
            () => defaultPaths('/candidate/ploinky', { env: { [name]: value } }),
            new RegExp(`${name} must be`),
        );
    }
});

test('release manifest rejects missing, extra, branch, and non-immutable identities', () => {
    const missing = manifest();
    delete missing.repositories.explorer;
    assert.throws(
        () => validateReleaseManifest(missing),
        /must contain exactly achillesAgentLib, achillesCLI, explorer, ploinky/,
    );

    const extra = manifest();
    extra.releaseSequence = 7;
    assert.throws(
        () => validateReleaseManifest(extra),
        /release manifest must contain exactly images, repositories/,
    );

    for (const invalid of ['master', 'A'.repeat(40), '1'.repeat(39), `${'1'.repeat(40)}-dirty`]) {
        const branchIdentity = manifest();
        branchIdentity.repositories.achillesAgentLib.commit = invalid;
        assert.throws(
            () => validateReleaseManifest(branchIdentity),
            /exact lowercase 40-hex commit/,
        );
    }

    for (const invalid of [
        'latest',
        'sha256:abc',
        `SHA256:${'5'.repeat(64)}`,
        `registry.invalid/ploinky@sha256:${'5'.repeat(64)}`,
    ]) {
        const mutableImage = manifest();
        mutableImage.images.ploinkyBox.digest = invalid;
        assert.throws(
            () => validateReleaseManifest(mutableImage),
            /immutable sha256:<64 lowercase hex> digest/,
        );
    }
});

test('delivery metadata requires the Box lock alone and rejects a second installed AgentLib', () => {
    const result = validateAgentlibDeliveryMetadata({
        globalPackage: globalPackage(),
        dependencyLock: dependencyLock(),
        expectedCommit: SHAS.achillesAgentLib,
    });
    assert.equal(result.commit, SHAS.achillesAgentLib);

    // A bundle whose globalDeps still installs achillesAgentLib would ship a
    // second, independently resolved copy alongside the direct mount.
    assert.throws(() => validateAgentlibDeliveryMetadata({
        globalPackage: globalPackage({ declaresAgentLib: true }),
        dependencyLock: dependencyLock(),
        expectedCommit: SHAS.achillesAgentLib,
    }), /must not declare achillesAgentLib/);

    assert.throws(() => validateAgentlibDeliveryMetadata({
        globalPackage: globalPackage(),
        dependencyLock: dependencyLock('6'.repeat(40)),
        expectedCommit: SHAS.achillesAgentLib,
    }), /must name the same AgentLib commit/);

    const alternateRemote = dependencyLock();
    alternateRemote.repositories.achillesAgentLib.url = 'not-a-github-url';
    assert.throws(() => validateAgentlibDeliveryMetadata({
        globalPackage: globalPackage(),
        dependencyLock: alternateRemote,
        expectedCommit: SHAS.achillesAgentLib,
    }), /Box dependency lock achillesAgentLib/);
});

test('root package accepts only the exact immutable lock-driven installer contract', () => {
    const paths = {
        rootPackagePath: '/candidate/ploinky/package.json',
        dependencyLockPath: '/candidate/ploinky/ploinky-box/dependencies.lock.json',
    };
    const valid = validateRootPackageInstaller({
        rootPackage: rootPackage(),
        ...paths,
    });
    assert.equal(valid.postinstall, LOCKED_ROOT_POSTINSTALL);

    for (const mutablePostinstall of [
        'cd node_modules; git clone https://github.com/AssistOS-AI/AchillesAgentLib.git achillesAgentLib',
        'git clone --branch master https://github.com/AssistOS-AI/AchillesAgentLib.git node_modules/achillesAgentLib',
        'npm install github:AssistOS-AI/AchillesAgentLib#master && mv package node_modules/achillesAgentLib',
        `${LOCKED_ROOT_POSTINSTALL} && git checkout master`,
        '',
    ]) {
        assert.throws(() => validateRootPackageInstaller({
            rootPackage: rootPackage(mutablePostinstall),
            ...paths,
        }), /immutable Box dependency-lock installer/);
    }
    assert.throws(() => validateRootPackageInstaller({
        rootPackage: rootPackage(),
        rootPackagePath: paths.rootPackagePath,
        dependencyLockPath: '/candidate/other/dependencies.lock.json',
    }), /must be tied to ploinky-box\/dependencies\.lock\.json/);
    assert.throws(() => validateRootPackageInstaller({
        rootPackage: { scripts: {} },
        ...paths,
    }), /immutable Box dependency-lock installer/);
});

test('exact dependency specs reject branches, shorthand, whitespace, and credentials', () => {
    assert.equal(
        parseExactGitCommitSpec(
            `git+https://github.com/AssistOS-AI/AchillesAgentLib.git#${SHAS.achillesAgentLib}`,
        ).commit,
        SHAS.achillesAgentLib,
    );
    for (const invalid of [
        'github:AssistOS-AI/AchillesAgentLib#master',
        'git+https://github.com/AssistOS-AI/AchillesAgentLib.git#master',
        ` git+https://github.com/AssistOS-AI/AchillesAgentLib.git#${SHAS.achillesAgentLib}`,
        `git+https://token@github.com/AssistOS-AI/AchillesAgentLib.git#${SHAS.achillesAgentLib}`,
    ]) {
        assert.throws(() => parseExactGitCommitSpec(invalid), /release bundle rejected/);
    }
});

test('release verifier rejects installed AgentLib mismatch or dirty component state', () => {
    assert.throws(
        () => verifyReleaseBundle(manifest(), verificationFixture({
            states: { achillesAgentLib: { head: '6'.repeat(40) } },
        })),
        /achillesAgentLib installed HEAD does not match/,
    );
    assert.throws(
        () => verifyReleaseBundle(manifest(), verificationFixture({
            states: { achillesAgentLib: { clean: false } },
        })),
        /achillesAgentLib repository has uncommitted or untracked content/,
    );
    assert.throws(
        () => verifyReleaseBundle(manifest(), verificationFixture({
            states: { explorer: { head: '6'.repeat(40) } },
        })),
        /explorer installed HEAD does not match/,
    );
});

test('command line requires the absolute manifest, every identity gate, and fail fallback', () => {
    const full = [
        '--manifest', '/tmp/copilot-421-release.json',
        '--require-agentlib-sha',
        '--require-ploinky-sha',
        '--require-achillescli-sha',
        '--require-explorer-sha',
        '--require-box-digest',
        '--branch-fallback', 'fail',
    ];
    assert.equal(parseCommandLine(full).branchFallback, 'fail');
    assert.throws(
        () => parseCommandLine(full.filter((value) => value !== '--require-agentlib-sha')),
        /missing required immutable-evidence gates: agentlibSha/,
    );
    assert.throws(
        () => parseCommandLine(full.map((value) => (value === 'fail' ? 'default' : value))),
        /--branch-fallback fail is mandatory/,
    );
    assert.throws(
        () => parseCommandLine(full.map((value) => (
            value === '/tmp/copilot-421-release.json' ? 'relative.json' : value
        ))),
        /--manifest must be an absolute path/,
    );
});

test('release manifest reader rejects symlinks, swaps, growth, and oversized evidence', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-421-release-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, 'release.json');
    fs.writeFileSync(real, JSON.stringify(manifest()));
    assert.deepEqual(readBoundedJsonFile(real), manifest());

    const linked = path.join(root, 'linked.json');
    fs.symlinkSync(real, linked);
    assert.throws(() => readBoundedJsonFile(linked), /single-link regular file/);

    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(oversized, 'x'.repeat((64 * 1024) + 1));
    assert.throws(() => readBoundedJsonFile(oversized), /exceeds 65536 bytes/);

    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, JSON.stringify({ swapped: true }));
    const swappedFs = {
        constants: fs.constants,
        lstatSync: (...args) => fs.lstatSync(...args),
        openSync: () => fs.openSync(replacement, fs.constants.O_RDONLY),
        fstatSync: (...args) => fs.fstatSync(...args),
        readSync: (...args) => fs.readSync(...args),
        closeSync: (...args) => fs.closeSync(...args),
    };
    assert.throws(
        () => readBoundedJsonFile(real, { fsApi: swappedFs }),
        /identity changed while opening/,
    );

    const growing = path.join(root, 'growing.json');
    fs.writeFileSync(growing, JSON.stringify(manifest()));
    let appended = false;
    const growingFs = {
        constants: fs.constants,
        lstatSync: (...args) => fs.lstatSync(...args),
        openSync: (...args) => fs.openSync(...args),
        fstatSync: (...args) => fs.fstatSync(...args),
        readSync(...args) {
            const read = fs.readSync(...args);
            if (!appended) {
                fs.appendFileSync(growing, ' ');
                appended = true;
            }
            return read;
        },
        closeSync: (...args) => fs.closeSync(...args),
    };
    assert.throws(
        () => readBoundedJsonFile(growing, { fsApi: growingFs }),
        /changed size while reading/,
    );
});
