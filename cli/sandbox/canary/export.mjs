import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const route = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function git(repo, ...args) {
    return execFileSync('git', [
        '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
        '-C', repo, ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}

function within(relative) {
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function repositoryPath(repo, target) {
    if (!path.isAbsolute(target)) throw new Error('canary source path must be absolute');
    const relative = path.relative(repo, fs.realpathSync(target));
    if (!within(relative)) throw new Error('canary source is outside its repository');
    return relative;
}

function readProbe(manifest, servedPorts) {
    const probe = manifest.canary?.probe;
    if (!probe) throw new Error('manifest has no canary probe declaration');
    if (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535
        || !Array.isArray(servedPorts) || !servedPorts.includes(probe.port)) {
        throw new Error('canary probe port must be a served TCP port');
    }
    if (typeof probe.path !== 'string' || !probe.path.startsWith('/') || probe.path.startsWith('//')
        || /[\\#\s\x00-\x1f\x7f]/u.test(probe.path) || !Number.isInteger(probe.status)
        || probe.status < 100 || probe.status > 599) throw new Error('invalid canary probe declaration');
    return { port: probe.port, path: probe.path, status: probe.status };
}

export function assertCanaryEligibility({ routeKey, inventoryRow, availableMemoryBytes, cacheConfirmation }) {
    if (typeof routeKey !== 'string' || !route.test(routeKey) || inventoryRow?.routeKey !== routeKey || inventoryRow?.eligible !== true) {
        throw new Error('no eligible inventory row for this canary route');
    }
    const need = inventoryRow.requiredMemoryBytes;
    if (!Number.isSafeInteger(need) || need <= 0 || !Number.isSafeInteger(availableMemoryBytes)
        || availableMemoryBytes < need) throw new Error('canary memory headroom is insufficient or unmeasured');
    if (!['no-shared-html-cache', 'no-store-and-purge-verified'].includes(cacheConfirmation)) {
        throw new Error('canary HTML cache precondition is unconfirmed');
    }
}

export function inspectCanarySource({
    repoRoot, codeDir, skillsDir = null, manifestPath = path.join(codeDir, 'manifest.json'), siblingDirs, servedPorts, commit,
}) {
    if (typeof commit !== 'string' || !sha.test(commit)) throw new Error('canary commit must be an exact lowercase object id');
    const repo = fs.realpathSync(repoRoot);
    if (fs.realpathSync(git(repo, 'rev-parse', '--show-toplevel').toString().trimEnd()) !== repo) {
        throw new Error('canary source is not the repository root');
    }
    if (git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none').length) {
        throw new Error('canary repository has uncommitted changes');
    }
    const oldCommit = git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
    if (git(repo, 'cat-file', '-t', commit).toString().trim() !== 'commit') throw new Error('invalid canary commit');
    try {
        git(repo, 'merge-base', '--is-ancestor', oldCommit, commit);
    } catch (error) {
        if (error.status === 1) throw new Error('canary commit is not a fast-forward of HEAD');
        throw error;
    }
    if (!Array.isArray(siblingDirs)) throw new Error('canary requires deployed sibling directories');
    for (const sibling of siblingDirs) {
        if (!path.isAbsolute(sibling)) throw new Error('deployed sibling directory must be absolute');
        const relative = path.relative(repo, fs.realpathSync(sibling));
        if (within(relative) && git(repo, 'diff', '--no-ext-diff', '--name-only', '-z', oldCommit, commit,
            '--', relative || '.').length) throw new Error('canary commit changes another deployed agent directory');
    }
    if (!fs.lstatSync(manifestPath).isFile()) throw new Error('canary manifest must be a regular file');
    const manifestRelative = repositoryPath(repo, manifestPath);
    const manifestBytes = git(repo, 'cat-file', 'blob', commit + ':' + manifestRelative);
    if (!manifestBytes.equals(fs.readFileSync(manifestPath))
        || git(repo, 'diff', '--no-ext-diff', '--name-only', '-z', oldCommit, commit, '--', manifestRelative).length) {
        throw new Error('canary candidate manifest differs from checkout manifest');
    }
    const codeRelative = repositoryPath(repo, codeDir);
    const skillsRelative = skillsDir ? repositoryPath(repo, skillsDir) : null;
    return {
        repoRoot: repo, oldCommit, commit, codeRelative, skillsRelative, manifestRelative,
        probe: readProbe(JSON.parse(manifestBytes), servedPorts),
    };
}

function exportPath(workspaceRoot, routeKey, commit, create) {
    if (!path.isAbsolute(workspaceRoot) || typeof routeKey !== 'string' || !route.test(routeKey) || !sha.test(commit)) {
        throw new Error('invalid canary export identity');
    }
    let dir = fs.realpathSync(workspaceRoot);
    for (const part of ['.ploinky', 'canary', routeKey]) {
        dir = path.join(dir, part);
        if (create) {
            try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('canary export parent must be a real directory');
    }
    return path.join(dir, commit);
}

function walkDirectories(directory, visit) {
    visit(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walkDirectories(path.join(directory, entry.name), visit);
    }
}

// The transaction verifies receipt ownership before removing this exact export.
export function removeCanaryExport({ workspaceRoot, routeKey, commit }) {
    const root = exportPath(workspaceRoot, routeKey, commit, false);
    const stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory()) throw new Error('canary export root must be a real directory');
    walkDirectories(root, (dir) => fs.chmodSync(dir, 0o700));
    fs.rmSync(root, { recursive: true });
}

function safePart(name) {
    return name && name !== '.' && name !== '..' && name.toLowerCase() !== '.git' && !/[\\:\x00-\x1f\x7f]/u.test(name);
}

function checkTree(repo, tree) {
    if (git(repo, 'cat-file', '-t', tree).toString().trim() !== 'tree') throw new Error('canary source must be a tree');
    const entries = new TextDecoder('utf-8', { fatal: true }).decode(git(repo, 'ls-tree', '-rzt', tree));
    const names = new Set();
    const paths = new Set();
    for (const line of entries.split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const name = line.slice(tab + 1);
        const key = name.normalize('NFC').toLowerCase();
        if (tab < 0 || !name.split('/').every(safePart) || names.has(key)
            || !/^(040000 tree|100644 blob|100755 blob|120000 blob) /.test(line.slice(0, tab))) {
            throw new Error('unsafe path, collision or unsupported entry in canary archive');
        }
        names.add(key);
        paths.add(name);
    }
    return paths;
}

// Compare the original ls-tree names, including directories, before adding
// synthetic mountpoints. git archive can silently omit tracked entries.
function verifyArchivePaths(target, expected, relative = '') {
    for (const entry of fs.readdirSync(path.join(target, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name);
        if (!expected.delete(name)) throw new Error('canary archive paths differ from the Git tree: ' + name);
        if (entry.isDirectory()) verifyArchivePaths(target, expected, name);
    }
    if (!relative && expected.size) {
        throw new Error('canary archive paths differ from the Git tree: missing ' + expected.values().next().value);
    }
}

function extractTree(source, relative, target, archive) {
    const tree = git(source.repoRoot, 'rev-parse', '--verify', source.commit + ':' + relative).toString().trim();
    const paths = checkTree(source.repoRoot, tree);
    fs.mkdirSync(target, { mode: 0o700 });
    git(source.repoRoot, 'archive', '--format=tar', '--output=' + archive, tree);
    execFileSync('tar', ['-xf', archive, '-C', target], {
        env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.unlinkSync(archive);
    verifyArchivePaths(target, paths);
}

// AgentServer searches the shared HOME when /code has no readable config.
// Freeze the candidate's selection, including its explicit lack of tools.
function freezeMcpSelection(source, codePath) {
    const filename = path.join(codePath, 'mcp-config.json');
    const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
    let bytes;
    if (existing) {
        const target = fs.realpathSync(filename);
        if (!within(path.relative(codePath, target)) || !fs.statSync(target).isFile()) {
            throw new Error('canary MCP configuration must be a file inside the code export');
        }
        bytes = fs.readFileSync(target);
        // A nested volume may shadow the target of a repository symlink.
        // Bind this launch to the bytes of the pinned config itself.
        if (existing.isSymbolicLink()) {
            fs.unlinkSync(filename);
            fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
    } else {
        // With a separate code/ tree the ordinary launch also looks beside the
        // agent manifest. Read that file from the same pinned commit.
        const relative = path.posix.join(path.posix.dirname(source.manifestRelative), 'mcp-config.json');
        const entry = git(source.repoRoot, 'ls-tree', '-z', source.commit, '--', relative).toString();
        if (entry && !/^100(?:644|755) blob /.test(entry)) throw new Error('invalid canary MCP configuration entry');
        bytes = entry ? git(source.repoRoot, 'cat-file', 'blob', source.commit + ':' + relative) : Buffer.from('{}\n');
        fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    try { JSON.parse(bytes); }
    catch { throw new Error('invalid JSON in canary MCP configuration'); }
}

function mountPoint(codePath, target, type) {
    if (!target.startsWith('/code/') || !['file', 'directory'].includes(type)) throw new Error('invalid code mountpoint');
    const parts = target.slice('/code/'.length).split('/');
    if (!parts.every(safePart)) throw new Error('invalid code mountpoint path');
    let current = codePath;
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const file = index === parts.length - 1 && type === 'file';
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat) {
            if (file ? !stat.isFile() : !stat.isDirectory()) throw new Error('invalid existing code mountpoint');
        } else if (file) fs.closeSync(fs.openSync(current, 'wx', 0o600));
        else fs.mkdirSync(current, { mode: 0o700 });
    }
}

// Resolve one component at a time so even a chain of relative links cannot
// leave the particular /code or /code/skills mount during validation.
function validateLink(mountRoot, filename) {
    const pending = path.relative(mountRoot, filename).split(path.sep);
    const resolved = [];
    let links = 0;
    while (pending.length) {
        const part = pending.shift();
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!resolved.length) throw new Error('canary link escapes its mounted archive');
            resolved.pop();
            continue;
        }
        const current = path.join(mountRoot, ...resolved, part);
        if (fs.lstatSync(current).isSymbolicLink()) {
            const target = fs.readlinkSync(current);
            if (path.isAbsolute(target)) throw new Error('canary link escapes its mounted archive');
            if (++links > 40) throw new Error('canary archive has a cyclic or excessive link chain');
            pending.unshift(...target.split(path.sep));
        } else resolved.push(part);
    }
}

function freezeTree(root, relative, digest, mountRoot) {
    const filename = path.join(root, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(filename);
        validateLink(mountRoot, filename);
        digest.update(JSON.stringify([relative, 'link', target]) + '\n');
    } else if (stat.isDirectory()) {
        digest.update(JSON.stringify([relative, 'dir']) + '\n');
        for (const name of fs.readdirSync(filename).sort()) {
            freezeTree(root, path.join(relative, name), digest, mountRoot || path.join(root, name));
        }
        fs.chmodSync(filename, 0o555);
    } else if (stat.isFile()) {
        const mode = stat.mode & 0o111 ? 0o555 : 0o444;
        digest.update(JSON.stringify([relative, mode, stat.size]) + '\n');
        const fd = fs.openSync(filename, 'r');
        const buffer = Buffer.allocUnsafe(65536);
        try {
            let size;
            while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
        } finally { fs.closeSync(fd); }
        fs.chmodSync(filename, mode);
    } else throw new Error('unsupported canary archive entry');
}

export function exportCanarySource({ workspaceRoot, routeKey, source, mountPoints = [] }) {
    const { commit, codeRelative, skillsRelative } = source;
    const exportRoot = exportPath(workspaceRoot, routeKey, commit, true);
    // Exclusive creation protects an existing rollout, including a partially written one.
    fs.mkdirSync(exportRoot, { mode: 0o700 });
    try {
        const codePath = path.join(exportRoot, 'code');
        const archive = path.join(exportRoot, '.archive');
        extractTree(source, codeRelative, codePath, archive);
        let skillsPath = null;
        if (skillsRelative !== null) {
            const nested = path.posix.relative(codeRelative || '.', skillsRelative || '.');
            if (within(nested)) {
                skillsPath = path.join(codePath, nested);
                if (!fs.lstatSync(skillsPath).isDirectory()) throw new Error('canary skills tree is missing');
            } else {
                skillsPath = path.join(exportRoot, 'skills');
                extractTree(source, skillsRelative, skillsPath, archive);
                mountPoint(codePath, '/code/skills', 'directory');
            }
        }
        mountPoint(codePath, '/code/node_modules', 'directory');
        for (const point of mountPoints) {
            if (point.target === '/code/mcp-config.json') throw new Error('live volume shadows the canary MCP configuration');
            mountPoint(codePath, point.target, point.type);
        }
        freezeMcpSelection(source, codePath);
        const digest = createHash('sha256');
        freezeTree(exportRoot, '', digest, null);
        return { exportRoot, codePath, skillsPath, codeDigest: 'sha256:' + digest.digest('hex') };
    } catch (error) {
        removeCanaryExport({ workspaceRoot, routeKey, commit });
        throw error;
    }
}
