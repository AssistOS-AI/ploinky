#!/usr/bin/env node
/**
 * A4 wrapper: run focused offline test files one at a time with the TAP
 * reporter and bind each TAP file to the exact commit it ran at.
 *
 *   node offline-tap.mjs --repo-name ploinky --repo-root <abs> --out <dir> <file> [<file> ...]
 *
 * For each file it writes <slug>.tap and <slug>.sidecar.json with the repo,
 * file, `git rev-parse HEAD`, a clean-tree flag, the command, the exit code
 * and the TAP sha256. Inherited PLOINKY_AGENTLIB_DIR and TMPDIR are passed
 * through. Exit 1 if any file fails or the tree is not clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runOfflineTap({ repoName, repoRoot, out, files, run = spawnSync, git = (args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim() }) {
    if (!path.isAbsolute(repoRoot) || !path.isAbsolute(out)) throw new Error('absolute --repo-root and --out are required');
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const commit = git(['rev-parse', 'HEAD']);
    const clean = git(['status', '--porcelain']) === '';
    const results = [];
    for (const file of files) {
        const args = ['--test', '--test-reporter=tap', file];
        const child = run(process.execPath, args, { cwd: repoRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const tap = String(child.stdout || '');
        const slug = `${repoName}__${file.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
        fs.writeFileSync(path.join(out, `${slug}.tap`), tap, { flag: 'wx', mode: 0o600 });
        const sidecar = { repo: repoName, file, commit, clean, command: `node ${args.join(' ')}`, cwd: repoRoot, node: process.version, exitCode: child.status, signal: child.signal || null, tapFile: `${slug}.tap`, tapSha256: createHash('sha256').update(tap).digest('hex') };
        fs.writeFileSync(path.join(out, `${slug}.sidecar.json`), JSON.stringify(sidecar, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        results.push(sidecar);
    }
    return { commit, clean, results, ok: clean && results.every(r => r.exitCode === 0) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const opts = {};
    const files = [];
    for (let i = 0; i < argv.length; i++) {
        if (['--repo-name', '--repo-root', '--out'].includes(argv[i])) opts[argv[i].slice(2)] = argv[++i];
        else files.push(argv[i]);
    }
    try {
        const result = runOfflineTap({ repoName: opts['repo-name'], repoRoot: opts['repo-root'], out: opts.out, files });
        for (const r of result.results) console.log(`${r.exitCode === 0 ? 'ok' : 'FAILED'} exit=${r.exitCode} ${r.repo}:${r.file} tap=${r.tapSha256}`);
        console.log(JSON.stringify({ commit: result.commit, clean: result.clean, ok: result.ok }));
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        console.error(error?.message || String(error));
        process.exitCode = 1;
    }
}
