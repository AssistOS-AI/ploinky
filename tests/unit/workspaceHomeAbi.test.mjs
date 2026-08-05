import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    AGENT_HOME_ABI_MARKER,
    ensureAgentHomeAbi,
    getAgentHomeAbiPath,
    getAgentWorkDir,
} from '../../cli/utils/workspaceStructure.js';

function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-home-abi-')));
    const agentsDataDir = path.join(root, '.data');
    fs.mkdirSync(agentsDataDir, { mode: 0o700 });
    return { root, agentsDataDir };
}

function removeFixture(value) {
    fs.rmSync(value.root, { recursive: true, force: true });
}

function exactMode(target) {
    return fs.lstatSync(target).mode & 0o7777;
}

function sandboxHomeKey(runtimeKey) {
    return `${runtimeKey}.sandbox-v2`;
}

function markerBytes(runtimeKey, createdByGeneration = 'generation-original') {
    return `${JSON.stringify({
        abi: 'ploinky-home-v2',
        createdByGeneration,
        homeKey: sandboxHomeKey(runtimeKey),
        schemaVersion: 2,
    })}\n`;
}

function assertIncompatible(callback) {
    assert.throws(callback, (error) => {
        assert.equal(error.code, 'PLOINKY_HOME_STATE_INCOMPATIBLE');
        assert.match(error.message, /Archive or reset this agent HOME explicitly/);
        return true;
    });
}

test('clean HOME ABI preserves the exact safe key and writes a canonical immutable marker', () => {
    const value = fixture();
    try {
        const homeKey = 'repo.agent-alias_1';
        const result = ensureAgentHomeAbi(homeKey, 'generation-original', {
            agentsDataDir: value.agentsDataDir,
        });
        const expectedHomeKey = sandboxHomeKey(homeKey);
        const expectedHome = path.join(value.agentsDataDir, expectedHomeKey);
        assert.equal(result.homePath, expectedHome);
        assert.equal(result.homeKey, expectedHomeKey);
        assert.equal(getAgentHomeAbiPath(homeKey, {
            agentsDataDir: value.agentsDataDir,
        }), expectedHome);
        assert.equal(exactMode(expectedHome), 0o700);
        assert.equal(exactMode(result.markerPath), 0o600);
        assert.equal(fs.readFileSync(result.markerPath, 'utf8'), markerBytes(homeKey));

        fs.writeFileSync(path.join(expectedHome, 'provider-state.json'), '{"keep":true}\n');
        const originalMarker = fs.readFileSync(result.markerPath, 'utf8');
        const reused = ensureAgentHomeAbi(homeKey, 'generation-later', {
            agentsDataDir: value.agentsDataDir,
        });
        assert.equal(reused.createdByGeneration, 'generation-original');
        assert.equal(fs.readFileSync(result.markerPath, 'utf8'), originalMarker);
        assert.equal(fs.readFileSync(path.join(expectedHome, 'provider-state.json'), 'utf8'), '{"keep":true}\n');

        assert.match(getAgentWorkDir('repo/agent'), /repo_agent$/);
    } finally {
        removeFixture(value);
    }
});

test('an existing truly empty HOME receives the marker but unmarked state is never adopted', () => {
    const emptyFixture = fixture();
    try {
        const emptyHome = path.join(emptyFixture.agentsDataDir, sandboxHomeKey('empty-home'));
        fs.mkdirSync(emptyHome, { mode: 0o700 });
        assert.doesNotThrow(() => ensureAgentHomeAbi('empty-home', 'generation-empty', {
            agentsDataDir: emptyFixture.agentsDataDir,
        }));
        assert.equal(fs.readFileSync(path.join(emptyHome, AGENT_HOME_ABI_MARKER), 'utf8'),
            markerBytes('empty-home', 'generation-empty'));
    } finally {
        removeFixture(emptyFixture);
    }

    const occupiedFixture = fixture();
    try {
        const occupiedHome = path.join(occupiedFixture.agentsDataDir, sandboxHomeKey('occupied-home'));
        fs.mkdirSync(occupiedHome, { mode: 0o700 });
        const statePath = path.join(occupiedHome, 'credentials.json');
        fs.writeFileSync(statePath, 'do-not-touch');
        assertIncompatible(() => ensureAgentHomeAbi('occupied-home', 'generation-new', {
            agentsDataDir: occupiedFixture.agentsDataDir,
        }));
        assert.equal(fs.readFileSync(statePath, 'utf8'), 'do-not-touch');
        assert.equal(fs.existsSync(path.join(occupiedHome, AGENT_HOME_ABI_MARKER)), false);
    } finally {
        removeFixture(occupiedFixture);
    }
});

test('HOME ABI rejects lossy, traversal, empty, and suffix-unsafe keys and empty generations', () => {
    const value = fixture();
    try {
        for (const homeKey of [
            '',
            '.',
            '..',
            'repo/agent',
            'repo\\agent',
            'space key',
            'ümlaut',
            'a'.repeat(245),
        ]) {
            assertIncompatible(() => ensureAgentHomeAbi(homeKey, 'generation', {
                agentsDataDir: value.agentsDataDir,
            }));
        }
        for (const generation of [
            '',
            null,
            undefined,
            ' leading',
            'trailing ',
            'line\nbreak',
            'nul\0byte',
            'quote"generation',
            'backslash\\generation',
            'unicode- generation-λ',
            'a'.repeat(256),
            'é'.repeat(128),
        ]) {
            assertIncompatible(() => ensureAgentHomeAbi('safe-key', generation, {
                agentsDataDir: value.agentsDataDir,
            }));
        }
        assert.deepEqual(fs.readdirSync(value.agentsDataDir), []);
        const boundaryKey = 'k'.repeat(244);
        const boundaryPath = getAgentHomeAbiPath(boundaryKey, {
            agentsDataDir: value.agentsDataDir,
        });
        assert.equal(Buffer.byteLength(path.basename(boundaryPath)), 255);
        const boundaryGeneration = 'g'.repeat(255);
        const boundary = ensureAgentHomeAbi(boundaryKey, boundaryGeneration, {
            agentsDataDir: value.agentsDataDir,
        });
        assert.equal(boundary.createdByGeneration, boundaryGeneration);
    } finally {
        removeFixture(value);
    }
});

test('malformed, noncanonical, mismatched, and permissive HOME state fails without rewrite', () => {
    const cases = [
        { name: 'malformed', bytes: '{not-json}\n' },
        { name: 'missing-field', bytes: '{"abi":"ploinky-home-v2"}\n' },
        {
            name: 'extra-field',
            bytes: '{"abi":"ploinky-home-v2","createdByGeneration":"generation-original","homeKey":"extra-field.sandbox-v2","schemaVersion":2,"extra":true}\n',
        },
        { name: 'key-mismatch', bytes: markerBytes('different-key') },
        {
            name: 'noncanonical',
            bytes: `${JSON.stringify({
                abi: 'ploinky-home-v2',
                createdByGeneration: 'generation-original',
                homeKey: sandboxHomeKey('noncanonical'),
                schemaVersion: 2,
            }, null, 2)}\n`,
        },
        { name: 'missing-newline', bytes: markerBytes('missing-newline').trimEnd() },
        {
            name: 'unsafe-generation',
            bytes: markerBytes('unsafe-generation', 'generation"forged'),
        },
    ];
    for (const entry of cases) {
        const value = fixture();
        try {
            const home = path.join(value.agentsDataDir, sandboxHomeKey(entry.name));
            const marker = path.join(home, AGENT_HOME_ABI_MARKER);
            fs.mkdirSync(home, { mode: 0o700 });
            fs.writeFileSync(marker, entry.bytes, { mode: 0o600 });
            assertIncompatible(() => ensureAgentHomeAbi(entry.name, 'generation-later', {
                agentsDataDir: value.agentsDataDir,
            }));
            assert.equal(fs.readFileSync(marker, 'utf8'), entry.bytes);
        } finally {
            removeFixture(value);
        }
    }

    const wrongModes = fixture();
    try {
        const home = path.join(wrongModes.agentsDataDir, sandboxHomeKey('wrong-mode'));
        const marker = path.join(home, AGENT_HOME_ABI_MARKER);
        fs.mkdirSync(home, { mode: 0o700 });
        fs.writeFileSync(marker, markerBytes('wrong-mode'), { mode: 0o600 });
        fs.chmodSync(home, 0o755);
        assertIncompatible(() => ensureAgentHomeAbi('wrong-mode', 'generation', {
            agentsDataDir: wrongModes.agentsDataDir,
        }));
        fs.chmodSync(home, 0o700);
        fs.chmodSync(marker, 0o644);
        assertIncompatible(() => ensureAgentHomeAbi('wrong-mode', 'generation', {
            agentsDataDir: wrongModes.agentsDataDir,
        }));
    } finally {
        removeFixture(wrongModes);
    }
});

test('symlinked data, HOME, and marker paths fail closed', () => {
    const value = fixture();
    try {
        const dataLink = path.join(value.root, 'data-link');
        fs.symlinkSync(value.agentsDataDir, dataLink, 'dir');
        assertIncompatible(() => ensureAgentHomeAbi('data-link-home', 'generation', {
            agentsDataDir: dataLink,
        }));

        const externalHome = path.join(value.root, 'external-home');
        fs.mkdirSync(externalHome, { mode: 0o700 });
        fs.symlinkSync(externalHome, path.join(value.agentsDataDir, sandboxHomeKey('linked-home')), 'dir');
        assertIncompatible(() => ensureAgentHomeAbi('linked-home', 'generation', {
            agentsDataDir: value.agentsDataDir,
        }));

        const markerHome = path.join(value.agentsDataDir, sandboxHomeKey('linked-marker'));
        const externalMarker = path.join(value.root, 'external-marker.json');
        fs.mkdirSync(markerHome, { mode: 0o700 });
        fs.writeFileSync(externalMarker, markerBytes('linked-marker'), { mode: 0o600 });
        fs.symlinkSync(externalMarker, path.join(markerHome, AGENT_HOME_ABI_MARKER));
        assertIncompatible(() => ensureAgentHomeAbi('linked-marker', 'generation', {
            agentsDataDir: value.agentsDataDir,
        }));
    } finally {
        removeFixture(value);
    }
});

test('an atomic marker creation race fails instead of adopting the competing marker', () => {
    const value = fixture();
    const homeKey = 'raced-home';
    const markerPath = path.join(value.agentsDataDir, sandboxHomeKey(homeKey), AGENT_HOME_ABI_MARKER);
    const originalOpenSync = fs.openSync;
    let injected = false;
    try {
        fs.openSync = function racedOpenSync(target, flags, mode) {
            if (!injected && target === markerPath) {
                injected = true;
                const competingFd = originalOpenSync.call(fs, target, 'wx', 0o600);
                try {
                    fs.writeFileSync(competingFd, markerBytes(homeKey, 'competing-generation'), 'utf8');
                    fs.fsyncSync(competingFd);
                } finally {
                    fs.closeSync(competingFd);
                }
            }
            return originalOpenSync.call(fs, target, flags, mode);
        };
        assertIncompatible(() => ensureAgentHomeAbi(homeKey, 'requested-generation', {
            agentsDataDir: value.agentsDataDir,
        }));
        assert.equal(injected, true);
        assert.equal(fs.readFileSync(markerPath, 'utf8'), markerBytes(homeKey, 'competing-generation'));
    } finally {
        fs.openSync = originalOpenSync;
        removeFixture(value);
    }
});

test('a file appearing between the empty check and marker creation fails closed', () => {
    const value = fixture();
    const homeKey = 'raced-state-home';
    const homePath = path.join(value.agentsDataDir, sandboxHomeKey(homeKey));
    const markerPath = path.join(homePath, AGENT_HOME_ABI_MARKER);
    const racedStatePath = path.join(homePath, 'credentials.json');
    const originalOpenSync = fs.openSync;
    let injected = false;
    try {
        fs.openSync = function racedOpenSync(target, flags, mode) {
            if (!injected && target === markerPath) {
                injected = true;
                fs.writeFileSync(racedStatePath, 'competing-state');
            }
            return originalOpenSync.call(fs, target, flags, mode);
        };
        assertIncompatible(() => ensureAgentHomeAbi(homeKey, 'requested-generation', {
            agentsDataDir: value.agentsDataDir,
        }));
        assert.equal(injected, true);
        assert.equal(fs.readFileSync(racedStatePath, 'utf8'), 'competing-state');
        assert.equal(fs.readFileSync(markerPath, 'utf8'), markerBytes(homeKey, 'requested-generation'));
    } finally {
        fs.openSync = originalOpenSync;
        removeFixture(value);
    }
});

test('sandbox HOME creation never reads or modifies the unsuffixed container HOME sibling', () => {
    const value = fixture();
    const runtimeKey = 'shared-runtime-key';
    const containerHome = path.join(value.agentsDataDir, runtimeKey);
    const sentinel = path.join(containerHome, 'container-state.json');
    try {
        fs.mkdirSync(containerHome, { mode: 0o755 });
        fs.writeFileSync(sentinel, '{"container":true}\n', { mode: 0o644 });
        const beforeHome = fs.lstatSync(containerHome);
        const beforeSentinel = fs.lstatSync(sentinel);

        const sandboxHome = ensureAgentHomeAbi(runtimeKey, 'generation-sandbox', {
            agentsDataDir: value.agentsDataDir,
        });

        assert.equal(sandboxHome.homeKey, sandboxHomeKey(runtimeKey));
        assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"container":true}\n');
        const afterHome = fs.lstatSync(containerHome);
        const afterSentinel = fs.lstatSync(sentinel);
        assert.equal(afterHome.ino, beforeHome.ino);
        assert.equal(afterHome.mode, beforeHome.mode);
        assert.equal(afterHome.mtimeNs, beforeHome.mtimeNs);
        assert.equal(afterSentinel.ino, beforeSentinel.ino);
        assert.equal(afterSentinel.mode, beforeSentinel.mode);
        assert.equal(afterSentinel.mtimeNs, beforeSentinel.mtimeNs);
        assert.equal(fs.existsSync(path.join(containerHome, AGENT_HOME_ABI_MARKER)), false);
    } finally {
        removeFixture(value);
    }
});
