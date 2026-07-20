import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    GIT_DEPS_MARKER_FILENAME,
    readGitDepsMarker,
    writeGitDepsMarker,
    invalidateDepsCacheForMovingGitDeps,
} from '../../cli/utils/dependencies/dependencyCache.js';

function tempDir(prefix = 'deps-invalidate-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Recreate the .ploinky/deps layout: global/ and agents/ each carry a cache
// directory with a node_modules tree (the thing that would hold a stale moving
// git dependency). The marker lives at the deps root, beside them.
function seedDepsCache(depsDir) {
    const globalCache = path.join(depsDir, 'global', 'container-linux-x64-glibc-node24');
    const agentCache = path.join(depsDir, 'agents', 'repoX', 'agentY', 'container-linux-x64-glibc-node24');
    for (const cache of [globalCache, agentCache]) {
        fs.mkdirSync(path.join(cache, 'node_modules', 'achillesAgentLib'), { recursive: true });
    }
    return { globalCache, agentCache };
}

const A1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A2 = '1111111111111111111111111111111111111111';
const B1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('writeGitDepsMarker + readGitDepsMarker round-trip a commits map', () => {
    const depsDir = tempDir();
    try {
        const written = writeGitDepsMarker(depsDir, { achillesAgentLib: A1, 'mcp-sdk': B1 });
        assert.deepEqual(written.commits, { achillesAgentLib: A1, 'mcp-sdk': B1 });
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A1, 'mcp-sdk': B1 });
        assert.equal(
            path.basename(path.join(depsDir, GIT_DEPS_MARKER_FILENAME)),
            GIT_DEPS_MARKER_FILENAME,
        );
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('readGitDepsMarker returns null when no marker exists', () => {
    const depsDir = tempDir();
    try {
        assert.equal(readGitDepsMarker(depsDir), null);
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: a changed dep commit removes caches and updates the marker', () => {
    const depsDir = tempDir();
    try {
        const { globalCache, agentCache } = seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1, 'mcp-sdk': B1 });

        const result = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: A2, 'mcp-sdk': B1 },
            { depsDir, log() {} },
        );

        assert.equal(result.invalidated, true);
        assert.deepEqual(result.changed, ['achillesAgentLib']);
        assert.equal(fs.existsSync(globalCache), false, 'global cache removed');
        assert.equal(fs.existsSync(agentCache), false, 'agent cache removed');
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A2, 'mcp-sdk': B1 });
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: a newly added moving dep (mcp-sdk) triggers invalidation', () => {
    const depsDir = tempDir();
    try {
        const { globalCache } = seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1 }); // marker predates mcp-sdk tracking

        const result = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: A1, 'mcp-sdk': B1 },
            { depsDir, log() {} },
        );

        assert.equal(result.invalidated, true);
        assert.deepEqual(result.changed, ['mcp-sdk']);
        assert.equal(fs.existsSync(globalCache), false);
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A1, 'mcp-sdk': B1 });
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: all commits unchanged is a no-op (no reinstall, caches preserved)', () => {
    const depsDir = tempDir();
    try {
        const { globalCache, agentCache } = seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1, 'mcp-sdk': B1 });

        const result = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: A1, 'mcp-sdk': B1 },
            { depsDir, log() {} },
        );

        assert.equal(result.invalidated, false);
        assert.equal(fs.existsSync(globalCache), true, 'global cache preserved');
        assert.equal(fs.existsSync(agentCache), true, 'agent cache preserved');
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: missing marker records a baseline WITHOUT wiping caches', () => {
    // A fresh deploy builds caches + containers but never writes the marker.
    // The first `ploinky update` must NOT wipe those caches (the containers
    // bind-mount them, so deleting would break `podman start` on restart) — it
    // adopts the current commits as the baseline so future moves are detected.
    const depsDir = tempDir();
    try {
        const { globalCache, agentCache } = seedDepsCache(depsDir);

        const result = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: A1, 'mcp-sdk': B1 },
            { depsDir, log() {} },
        );

        assert.equal(result.invalidated, false, 'no wipe when there is no prior marker');
        assert.equal(result.reason, 'baseline recorded');
        assert.equal(fs.existsSync(globalCache), true, 'global cache preserved');
        assert.equal(fs.existsSync(agentCache), true, 'agent cache preserved');
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A1, 'mcp-sdk': B1 });
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: no resolved commits (offline) is a no-op and preserves caches + marker', () => {
    const depsDir = tempDir();
    try {
        const { globalCache } = seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1 });

        const empty = invalidateDepsCacheForMovingGitDeps({}, { depsDir, log() {} });
        const allNull = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: null, 'mcp-sdk': '   ' },
            { depsDir, log() {} },
        );

        assert.equal(empty.invalidated, false);
        assert.equal(allNull.invalidated, false);
        assert.equal(fs.existsSync(globalCache), true, 'caches untouched when nothing resolved');
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A1 }, 'marker untouched');
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: a dep that failed to resolve is ignored, not treated as a change', () => {
    const depsDir = tempDir();
    try {
        const { globalCache } = seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1, 'mcp-sdk': B1 });

        // Only achillesAgentLib resolved (unchanged); mcp-sdk omitted (ls-remote failed).
        const result = invalidateDepsCacheForMovingGitDeps(
            { achillesAgentLib: A1 },
            { depsDir, log() {} },
        );

        assert.equal(result.invalidated, false, 'unresolved dep is not a false-positive change');
        assert.equal(fs.existsSync(globalCache), true);
        // Marker keeps the prior mcp-sdk entry.
        assert.deepEqual(readGitDepsMarker(depsDir).commits, { achillesAgentLib: A1, 'mcp-sdk': B1 });
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});

test('invalidate: marker is preserved outside the cleaned dirs and rewritten', () => {
    const depsDir = tempDir();
    try {
        seedDepsCache(depsDir);
        writeGitDepsMarker(depsDir, { achillesAgentLib: A1 });

        invalidateDepsCacheForMovingGitDeps({ achillesAgentLib: A2 }, { depsDir, log() {} });

        assert.equal(fs.existsSync(path.join(depsDir, GIT_DEPS_MARKER_FILENAME)), true);
        assert.equal(readGitDepsMarker(depsDir).commits.achillesAgentLib, A2);
    } finally {
        fs.rmSync(depsDir, { recursive: true, force: true });
    }
});
