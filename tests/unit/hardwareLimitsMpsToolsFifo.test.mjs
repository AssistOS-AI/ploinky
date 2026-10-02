import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { describeMpsTool, discoverMpsTools, MPS_TOOL_PATHS } from '../../ploinky-box/lib/mpsTools.mjs';

const moduleUrl = new URL('../../ploinky-box/lib/mpsTools.mjs', import.meta.url).href;
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mps-tool-fifo-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
    for (const name of Object.values(MPS_TOOL_PATHS)) fs.writeFileSync(path.join(tools, path.basename(name)), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const descriptors = discoverMpsTools({ directories: [tools] });
    const home = path.join(root, 'home'), temporary = path.join(root, 'tmp'); fs.mkdirSync(home); fs.mkdirSync(temporary);
    return { root, tools, descriptors, home, temporary };
}

for (const kind of ['fifo', 'symlink-to-fifo']) {
    for (const key of ['control', 'server']) {
        for (const operation of ['describe', 'discover', 'revalidate']) {
            test(`MFT.${operation} rejects ${key} ${kind} without waiting for a writer`, (t) => {
                const f = fixture(t);
                const source = f.descriptors[key].source;
                fs.unlinkSync(source);
                const fifo = kind === 'fifo' ? source : path.join(f.root, 'owned-fifo');
                const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 });
                assert.equal(made.status, 0, made.stderr);
                if (kind === 'symlink-to-fifo') fs.symlinkSync(fifo, source);
                const script = `
                    import { describeMpsTool, discoverMpsTools, revalidateMpsTools, MPS_TOOL_PATHS } from ${JSON.stringify(moduleUrl)};
                    const descriptors = ${JSON.stringify(f.descriptors)};
                    try {
                        const operation = ${JSON.stringify(operation)};
                        if (operation === 'describe') describeMpsTool(${JSON.stringify(source)}, MPS_TOOL_PATHS[${JSON.stringify(key)}]);
                        else if (operation === 'discover') discoverMpsTools({ directories: [${JSON.stringify(f.tools)}] });
                        else revalidateMpsTools(descriptors);
                        process.exitCode = 2;
                    } catch (error) { console.log(JSON.stringify({ rejected: true, message: error.message })); }
                `;
                const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                    cwd: f.root, encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 8192,
                    env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.temporary, PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR },
                });
                assert.equal(child.error, undefined, `special file blocked: ${child.error?.code}; signal=${child.signal}`);
                assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
                assert.equal(JSON.parse(child.stdout).rejected, true);
            });
        }
    }
}

test('MFT.nonblocking regular executable fingerprint remains exact through canonical symlinks', (t) => {
    const f = fixture(t);
    const source = f.descriptors.control.source;
    const link = path.join(f.root, 'regular-link'); fs.symlinkSync(source, link);
    assert.deepEqual(describeMpsTool(link, MPS_TOOL_PATHS.control), f.descriptors.control);
    assert.equal(fs.statSync(source).size, f.descriptors.control.size);
    const changed = '#!/bin/sh\nexit 1\n'; fs.writeFileSync(source, changed);
    assert.notEqual(describeMpsTool(link, MPS_TOOL_PATHS.control).sha256, f.descriptors.control.sha256);
});
