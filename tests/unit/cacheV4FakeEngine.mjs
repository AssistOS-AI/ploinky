// A stateful fake container engine for behavioral lifecycle tests (not a test
// file). The executable is written into a caller-provided temporary directory
// outside the package tree and put first on PATH by the test's child process.
//
// It models just enough of podman/docker for the Ploinky start path: image
// inspection by immutable ID, the runtime-key probe, the dependency installer
// container (acts as a fake npm that writes node_modules and a hidden lock),
// create/start/inspect/rm of managed containers with their bind mounts and
// labels, and a JSON log of every invocation.

import fs from 'node:fs';
import path from 'node:path';

const ENGINE_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_ENGINE_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { containers: {}, installs: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(argv) + '\n');
const IMAGE = 'sha256:' + (process.env.FAKE_ENGINE_IMAGE_HEX || 'a'.repeat(64));
const out = (s) => process.stdout.write(s);
const [cmd, sub] = argv;
function flagValues(args, flags) {
  const values = [];
  for (let i = 0; i < args.length; i++) if (flags.includes(args[i])) values.push(args[i + 1]);
  return values;
}
function mountsFrom(args) {
  return flagValues(args, ['-v', '--volume']).map((value) => {
    const parts = value.split(':');
    const opts = parts.length > 2 ? parts[2] : '';
    return { Type: 'bind', Source: parts[0], Destination: parts[1], RW: !/(^|,)ro(,|$)/.test(opts) };
  });
}
function fakeNpm(installDir, name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
  const nm = path.join(installDir, 'node_modules');
  const entries = fs.existsSync(nm) ? fs.readdirSync(nm) : [];
  state.installs.push({ name, installDir, preexisting: entries });
  fs.mkdirSync(nm, { recursive: true });
  const lock = { lockfileVersion: 3, packages: {} };
  for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
    if (dep === 'achillesAgentLib' || dep === 'ploinky-agent-lib') continue;
    fs.mkdirSync(path.join(nm, dep), { recursive: true });
    fs.writeFileSync(path.join(nm, dep, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }));
    fs.writeFileSync(path.join(nm, dep, 'index.js'), 'module.exports = ' + JSON.stringify(dep + '@' + spec) + ';\n');
    let resolved = 'https://registry.example/' + dep + '.tgz';
    const git = /github(?:\.com[/:]|:)([^/#]+)\/([^/#.]+)/i.exec(spec);
    if (git) resolved = 'git+ssh://git@github.com/' + git[1] + '/' + git[2] + '.git#' + 'c'.repeat(40);
    lock.packages['node_modules/' + dep] = { version: '1.0.0', resolved };
  }
  fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify(lock));
}
const find = (ref) => Object.values(state.containers).find((c) => c.Name === ref || c.Id === ref || (ref.length >= 12 && c.Id.startsWith(ref)));
function containerJson(c) { return { ...c, Config: { ...c.Config, Labels: c.Labels } }; }
if (cmd === '--version' || cmd === 'version') { out('podman version 5.0.0\n'); process.exit(0); }
if (cmd === 'info') { out('{}\n'); process.exit(0); }
if (cmd === 'image' && sub === 'inspect') {
  if (process.env.FAKE_ENGINE_NO_IMAGE === '1') { process.stderr.write('Error: image not known\n'); process.exit(125); }
  const fi = argv.indexOf('--format');
  const f = fi > 0 ? argv[fi + 1] : '';
  if (f.includes('.Id')) out(IMAGE + '\n');
  else if (f.startsWith('{{json')) out('null\n');
  else if (f) out('\n');
  else out(JSON.stringify([{ Id: IMAGE, Config: { Entrypoint: null, Cmd: ['node'], User: '' } }]));
  process.exit(0);
}
if (cmd === 'image' && sub === 'exists') process.exit(0);
if (cmd === 'image' && sub === 'mount') process.exit(125);
if (cmd === 'pull') process.exit(0);
if (cmd === 'run') {
  const nameIdx = argv.indexOf('--name');
  const name = nameIdx > 0 ? argv[nameIdx + 1] : '';
  if (name.startsWith('ploinky-deps-')) {
    const install = mountsFrom(argv).find((m) => m.Destination === '/install');
    fakeNpm(install.Source, name); save(); process.exit(0);
  }
  if (argv.includes('-x')) process.exit(0);
  if (argv.some((a) => String(a).includes('process.report'))) {
    out('{"platform":"linux","arch":"x64","nodeMajor":20,"libc":"glibc"}'); process.exit(0);
  }
  process.exit(0);
}
if (cmd === 'create') {
  const id = crypto.randomBytes(32).toString('hex');
  const name = argv[argv.indexOf('--name') + 1];
  const labels = {};
  for (const value of flagValues(argv, ['--label', '-l'])) { const [k, ...v] = value.split('='); labels[k] = v.join('='); }
  // Like the real engines, a later -e for the same key replaces the earlier one.
  const envMap = new Map();
  for (const entry of flagValues(argv, ['-e', '--env'])) envMap.set(String(entry).split('=')[0], entry);
  const env = [...envMap.values()];
  state.containers[name] = {
    Id: id, Name: name, Args: argv, Mounts: mountsFrom(argv), Labels: labels,
    Config: { Env: env, Labels: labels, User: '', WorkingDir: '' },
    State: { Running: false, Status: 'created' }, Image: IMAGE,
    HostConfig: { Init: argv.includes('--init'), NetworkMode: flagValues(argv, ['--network'])[0] || 'bridge' },
    NetworkSettings: { Networks: {} },
  };
  save(); out(id + '\n'); process.exit(0);
}
if (cmd === 'start') { const c = find(argv.at(-1)); if (!c) process.exit(125); c.State = { Running: true, Status: 'running' }; save(); out(c.Id + '\n'); process.exit(0); }
if (cmd === 'inspect' || (cmd === 'container' && sub === 'inspect')) {
  const skip = new Set(['--format', '-f', '--type']);
  const refs = argv.slice(cmd === 'container' ? 2 : 1).filter((a, i, all) => !a.startsWith('-') && !skip.has(all[i - 1]));
  const found = refs.map(find).filter(Boolean);
  if (!found.length) { process.stderr.write('Error: no such container ' + refs.join(' ') + '\n'); process.exit(125); }
  const fi = argv.findIndex((a) => a === '--format' || a === '-f');
  if (fi > 0) {
    const f = argv[fi + 1];
    if (f.includes('.Id')) out(found[0].Id + '\n');
    else if (f.includes('Running')) out(String(found[0].State.Running) + '\n');
    else if (f.includes('Labels')) out(JSON.stringify(found[0].Labels) + '\n');
    else out(JSON.stringify(containerJson(found[0])) + '\n');
    process.exit(0);
  }
  out(JSON.stringify(found.map(containerJson))); process.exit(0);
}
if (cmd === 'ps' || (cmd === 'container' && sub === 'ls')) { for (const c of Object.values(state.containers)) out(c.Name + '\n'); process.exit(0); }
if (cmd === 'rm' || (cmd === 'container' && sub === 'rm')) {
  for (const a of argv.slice(1)) { const c = a.startsWith('-') ? null : find(a); if (c) delete state.containers[c.Name]; }
  save(); process.exit(0);
}
if (cmd === 'stop' || cmd === 'kill') { const c = find(argv.at(-1)); if (c) c.State = { Running: false, Status: 'exited' }; save(); process.exit(0); }
process.exit(0);
`;

// Fake host npm: `--version` and `install` in the current directory, writing
// the same deterministic node_modules/hidden lock as the engine's installer.
const NPM_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('11.0.0-fake\n'); process.exit(0); }
if (argv[0] !== 'install') process.exit(1);
// The host installer passes an allowlisted environment only, so locate the
// shared state beside this executable instead of via the environment.
const stateFile = path.join(path.dirname(fs.realpathSync(__filename)), '..', 'fake-engine-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { containers: {}, installs: [] };
const dir = process.cwd();
const nm = path.join(dir, 'node_modules');
state.installs.push({ name: 'host-npm', installDir: dir, preexisting: fs.existsSync(nm) ? fs.readdirSync(nm) : [] });
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
fs.mkdirSync(nm, { recursive: true });
const lock = { lockfileVersion: 3, packages: {} };
for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
  if (dep === 'achillesAgentLib' || dep === 'ploinky-agent-lib') continue;
  fs.mkdirSync(path.join(nm, dep), { recursive: true });
  fs.writeFileSync(path.join(nm, dep, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }));
  fs.writeFileSync(path.join(nm, dep, 'index.js'), 'module.exports = ' + JSON.stringify(dep + '@' + spec) + ';\n');
  let resolved = 'https://registry.example/' + dep + '.tgz';
  const git = /github(?:\.com[/:]|:)([^/#]+)\/([^/#.]+)/i.exec(spec);
  if (git) resolved = 'git+ssh://git@github.com/' + git[1] + '/' + git[2] + '.git#' + 'c'.repeat(40);
  lock.packages['node_modules/' + dep] = { version: '1.0.0', resolved };
}
fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify(lock));
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
`;

// Fake sandbox-exec: records its pid and stays alive briefly like a service.
const SANDBOX_EXEC_SOURCE = '#!/bin/sh\necho $$ >> "$FAKE_ENGINE_PIDS"\nexec sleep 30\n';

export function installFakeEngine(directory, { engines = ['podman', 'docker'] } = {}) {
    const binDir = path.join(directory, 'fake-engine-bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of ['podman', 'docker']) {
        const file = path.join(binDir, name);
        // An engine that is not selected is present but unusable, so runtime
        // auto-detection deterministically picks the selected one.
        if (engines.includes(name)) fs.writeFileSync(file, ENGINE_SOURCE, { mode: 0o755 });
    }
    try { fs.symlinkSync(process.execPath, path.join(binDir, 'node')); } catch { /* already present */ }
    fs.writeFileSync(path.join(binDir, 'npm'), NPM_SOURCE, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'sandbox-exec'), SANDBOX_EXEC_SOURCE, { mode: 0o755 });
    // PATH without any other container engine, so runtime auto-detection is
    // deterministic even when the host or test runner provides one.
    const otherDirs = String(process.env.PATH || '').split(path.delimiter).filter((dir) => dir
        && !['podman', 'docker'].some((engine) => fs.existsSync(path.join(dir, engine))));
    const PATH = [binDir, ...otherDirs].join(path.delimiter);
    const stateFile = path.join(directory, 'fake-engine-state.json');
    const logFile = path.join(directory, 'fake-engine-log.jsonl');
    const pidFile = path.join(directory, 'fake-engine-pids');
    return {
        binDir,
        stateFile,
        logFile,
        env: { FAKE_ENGINE_STATE: stateFile, FAKE_ENGINE_LOG: logFile, FAKE_ENGINE_PIDS: pidFile, PATH },
        killSandboxes() {
            if (!fs.existsSync(pidFile)) return;
            for (const pid of fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter(Boolean)) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
            }
        },
        state() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { containers: {}, installs: [] }; },
        calls() {
            return fs.existsSync(logFile)
                ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
                : [];
        },
    };
}
