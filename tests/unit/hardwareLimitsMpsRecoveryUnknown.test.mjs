import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recoverMpsDaemonIdentity, cleanupMpsGeneration } from '../../cli/sandbox/hardwareLimits/mps.mjs';

const denied = (code) => Object.assign(new Error('fixture inspection unavailable'), { code });
const pipe = `/run/ploinky/mps/pipe-${'a'.repeat(32)}`;
const state = { daemon: null, pipeDirectory: pipe, tools: { control: { dev: 1, ino: 2 } } };
const statLine = (status = 'S') => `42 (mps-control) ${status} ${Array(18).fill('0').join(' ')} 123`;
function procFs({ error = 'EACCES', oversized = false, presence = 'live', matching = true, executableError = null, environment = null } = {}) {
    return {
        openSync() { throw denied('ENOENT'); }, readdirSync: () => ['42'],
        statSync() { if (executableError) throw denied(executableError); return { dev: 1, ino: matching ? 2 : 99 }; },
        readFileSync(target) {
            if (target.endsWith('/stat')) {
                if (presence === 'gone') throw denied('ENOENT');
                if (presence === 'unreadable') throw denied('EACCES');
                return statLine(presence === 'zombie' ? 'Z' : 'S');
            }
            assert.equal(target, '/proc/42/environ');
            if (environment !== null) return Buffer.from(environment);
            if (oversized) return Buffer.from(`CUDA_MPS_PIPE_DIRECTORY=${pipe}\0X=${'x'.repeat(8192)}\0`);
            throw denied(error);
        },
    };
}
for (const error of ['EACCES', 'EPERM', 'ENOENT']) {
    test(`MRU.matching executable with ${error} environment remains unknown while process exists`, () => {
        assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ error }), uid: 1000 }).state, 'unknown');
    });
}
test('MRU.oversized matching environment never proves daemon absence', () => {
    assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ oversized: true }), uid: 1000 }).state, 'unknown');
});
test('MRU.malformed zombie stat does not prove matching process termination', () => {
    const fsApi = procFs(); const read = fsApi.readFileSync;
    fsApi.readFileSync = (target) => target.endsWith('/stat') ? '42 (mps-control) Z' : read(target);
    assert.equal(recoverMpsDaemonIdentity(state, { fsApi, uid: 1000 }).state, 'unknown');
});
test('MRU.unreadable absence recheck retains unknown matching process', () => {
    assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ presence: 'unreadable' }), uid: 1000 }).state, 'unknown');
});
for (const presence of ['gone', 'zombie']) {
    test(`MRU.matching process re-proved ${presence} no longer blocks recovery`, () => {
        assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ presence }), uid: 1000 }).state, 'gone');
    });
}
for (const executableError of ['ENOENT', 'EACCES', 'EPERM']) {
    test(`MRU.unrelated unobserved ${executableError} executable does not block recovery`, () => {
        assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ executableError }), uid: 1000 }).state, 'gone');
    });
}
test('MRU.foreign executable and readable other-pipe environment do not block recovery', () => {
    assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ matching: false }), uid: 1000 }).state, 'gone');
    assert.equal(recoverMpsDaemonIdentity(state, { fsApi: procFs({ environment: 'CUDA_MPS_PIPE_DIRECTORY=/other\0' }), uid: 1000 }).state, 'gone');
});

for (const mode of ['EACCES', 'EPERM', 'oversized']) {
    test(`MRU.actual cleanup preserves exact owned pipe and log directories for ${mode} matching daemon`, (t) => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mps-unknown-recovery-')));
        fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const pipeDirectory = path.join(root, `pipe-${'b'.repeat(32)}`), logDirectory = path.join(root, `log-${'b'.repeat(32)}`);
        for (const directory of [pipeDirectory, logDirectory]) {
            fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, 'owned-evidence'), 'preserve', { mode: 0o600 });
        }
        const pipeStat = fs.statSync(pipeDirectory), logStat = fs.statSync(logDirectory);
        const candidate = { ...state, pipeDirectory, logDirectory,
            pipeIdentity: { dev: pipeStat.dev, ino: pipeStat.ino }, logIdentity: { dev: logStat.dev, ino: logStat.ino } };
        const proc = procFs({ error: mode, oversized: mode === 'oversized' });
        const fsApi = new Proxy(fs, { get(target, key) {
            if (['readdirSync', 'statSync', 'readFileSync'].includes(key)) return (file, ...args) => String(file).startsWith('/proc') ? proc[key](file, ...args) : fs[key](file, ...args);
            if (['lstatSync', 'fstatSync'].includes(key)) return (...args) => { const result = fs[key](...args); result.uid = 1000; return result; };
            return target[key];
        } });
        assert.throws(() => cleanupMpsGeneration(candidate, { root, fsApi, uid: 1000 }), /exact daemon termination/);
        assert.equal(fs.readFileSync(path.join(pipeDirectory, 'owned-evidence'), 'utf8'), 'preserve');
        assert.equal(fs.readFileSync(path.join(logDirectory, 'owned-evidence'), 'utf8'), 'preserve');
        assert.equal(fs.statSync(pipeDirectory).ino, pipeStat.ino); assert.equal(fs.statSync(logDirectory).ino, logStat.ino);
    });
}
