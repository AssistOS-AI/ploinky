import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hasExactAgentHomeLayout, resolveAgentHomeLayout } from '../../cli/sandbox/docker/agentHomeLayout.js';
import { buildAgentShellArgs } from '../../cli/sandbox/docker/agentShell.js';

test('HOME survives isolated, static, and project mode changes with one exact private bind', () => {
    const agentHomeDir = '/workspace/.data/namedAlias';
    for (const [cwd, cwdMountTarget, expectedHome] of [
        [agentHomeDir, '/root', '/root'],
        ['/workspace', '/root', '/home/agent'],
        ['/workspace/project', '/workspace/project', '/root'],
        [agentHomeDir, '/root', '/root'],
        [agentHomeDir, agentHomeDir, '/root'],
    ]) {
        const input = { cwd, cwdMountTarget, agentHomeDir };
        const layout = resolveAgentHomeLayout(input);
        assert.equal(layout.containerHome, expectedHome);
        assert.deepEqual(layout.binds.filter(bind => bind.target === expectedHome), [{
            source: agentHomeDir, target: expectedHome,
        }]);
        assert.deepEqual(layout.binds.find(bind => bind.target === cwdMountTarget), {
            source: cwd, target: cwdMountTarget,
        });
        assert.equal(new Set(layout.binds.map(bind => bind.target)).size, layout.binds.length);
        assert.deepEqual(resolveAgentHomeLayout(input), layout, 'restart must select the same layout');
    }
});

test('HOME layout normalizes equivalent paths before deduplicating /root mounts', () => {
    assert.deepEqual(resolveAgentHomeLayout({
        cwd: '/workspace/.data/demo/../demo',
        cwdMountTarget: '/root/../root/',
        agentHomeDir: '/workspace/.data/demo',
    }), {
        containerHome: '/root',
        binds: [{ source: '/workspace/.data/demo', target: '/root' }],
    });
    assert.equal(resolveAgentHomeLayout({
        cwd: '/workspace/',
        cwdMountTarget: '/root/./',
        agentHomeDir: '/workspace/.data/demo',
    }).containerHome, '/home/agent');
});

test('host/none reuse rejects legacy static HOME and requires the actual private writable bind', () => {
    const layout = resolveAgentHomeLayout({
        cwd: '/workspace', cwdMountTarget: '/root', agentHomeDir: '/workspace/.data/static',
    });
    const legacy = {
        Config: { Env: ['HOME=/root'] },
        Mounts: [{ Type: 'bind', Source: '/workspace', Destination: '/root', RW: true }],
    };
    assert.equal(hasExactAgentHomeLayout(legacy, layout), false);
    const correctedEnvOnly = structuredClone(legacy);
    correctedEnvOnly.Config.Env = ['HOME=/home/agent'];
    assert.equal(hasExactAgentHomeLayout(correctedEnvOnly, layout), false);
    const current = {
        Config: { Env: ['HOME=/home/agent'] },
        Mounts: layout.binds.map(bind => ({ Type: 'bind', Source: bind.source, Destination: bind.target, RW: true })),
    };
    assert.equal(hasExactAgentHomeLayout(current, layout), true);
    for (const mutate of [
        record => { record.Mounts[1].Source = '/workspace'; },
        record => { record.Mounts[1].RW = false; },
        record => { record.Mounts[1].Type = 'volume'; },
        record => { record.Mounts.push({ ...record.Mounts[1] }); },
        record => { record.Config.Env.push('HOME=/root'); },
    ]) {
        const drifted = structuredClone(current);
        mutate(drifted);
        assert.equal(hasExactAgentHomeLayout(drifted, layout), false);
    }
});

test('managed command shells retain private HOME and cannot run image login profiles in the project', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-shell-'));
    try {
        const runtimeHome = path.join(fixture, "private home 'quoted' $(literal)");
        fs.mkdirSync(runtimeHome);
        const imageProfileHome = path.join(fixture, 'project');
        fs.mkdirSync(imageProfileHome);
        const shellPath = path.join(fixture, 'profile shell');
        fs.writeFileSync(shellPath, `#!/bin/sh
if [ "$1" = '-lc' ]; then
    shift
    export HOME="$IMAGE_PROFILE_HOME"
    printf misplaced > "$HOME/.cache"
    exec /bin/sh -c "$@"
fi
exec /bin/sh "$@"
`, { mode: 0o755 });
        const env = { ...process.env, HOME: runtimeHome, IMAGE_PROFILE_HOME: imageProfileHome };
        const before = spawnSync(shellPath, ['-lc', 'printf "%s" "$HOME"'], { env, encoding: 'utf8' });
        assert.equal(before.status, 0, before.stderr);
        assert.equal(before.stdout, imageProfileHome, 'fixture must reproduce the login-profile reset');
        assert.equal(fs.readFileSync(path.join(imageProfileHome, '.cache'), 'utf8'), 'misplaced');
        fs.rmSync(path.join(imageProfileHome, '.cache'));
        const args = buildAgentShellArgs('printf "%s\\n%s\\n" "$HOME" "$#"; printf saved > "$HOME/cache"; exit 7', shellPath);
        const after = spawnSync(args[0], args.slice(1), { env, encoding: 'utf8' });
        assert.equal(after.status, 7, after.stderr);
        assert.equal(after.stdout, `${runtimeHome}\n0\n`);
        assert.equal(fs.readFileSync(path.join(runtimeHome, 'cache'), 'utf8'), 'saved');
        assert.equal(fs.existsSync(path.join(imageProfileHome, '.cache')), false);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
