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

function markerBytes(homeKey, createdByGeneration = 'generation-original') {
    return `${JSON.stringify({
        abi: 'ploinky-home-v2',
        createdByGeneration,
        homeKey,
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
        const expectedHome = path.join(value.agentsDataDir, homeKey);
        assert.equal(result.homePath, expectedHome);
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
        const emptyHome = path.join(emptyFixture.agentsDataDir, 'empty-home');
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
        const occupiedHome = path.join(occupiedFixture.agentsDataDir, 'occupied-home');
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

test('HOME ABI rejects lossy, traversal, empty, and oversized keys and empty generations', () => {
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
            'a'.repeat(256),
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
            'a'.repeat(256),
            'é'.repeat(128),
        ]) {
            assertIncompatible(() => ensureAgentHomeAbi('safe-key', generation, {
                agentsDataDir: value.agentsDataDir,
            }));
        }
        assert.deepEqual(fs.readdirSync(value.agentsDataDir), []);
        const boundaryGeneration = 'g'.repeat(255);
        const boundary = ensureAgentHomeAbi('boundary-generation', boundaryGeneration, {
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
            bytes: '{"abi":"ploinky-home-v2","createdByGeneration":"generation-original","homeKey":"extra-field","schemaVersion":2,"extra":true}\n',
        },
        { name: 'key-mismatch', bytes: markerBytes('different-key') },
        {
            name: 'noncanonical',
            bytes: `${JSON.stringify({
                abi: 'ploinky-home-v2',
                createdByGeneration: 'generation-original',
                homeKey: 'noncanonical',
                schemaVersion: 2,
            }, null, 2)}\n`,
        },
        { name: 'missing-newline', bytes: markerBytes('missing-newline').trimEnd() },
    ];
    for (const entry of cases) {
        const value = fixture();
        try {
            const home = path.join(value.agentsDataDir, entry.name);
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
        const home = path.join(wrongModes.agentsDataDir, 'wrong-mode');
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
        fs.symlinkSync(externalHome, path.join(value.agentsDataDir, 'linked-home'), 'dir');
        assertIncompatible(() => ensureAgentHomeAbi('linked-home', 'generation', {
            agentsDataDir: value.agentsDataDir,
        }));

        const markerHome = path.join(value.agentsDataDir, 'linked-marker');
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
    const markerPath = path.join(value.agentsDataDir, homeKey, AGENT_HOME_ABI_MARKER);
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
    const homePath = path.join(value.agentsDataDir, homeKey);
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
