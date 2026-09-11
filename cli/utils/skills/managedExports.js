import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXPORT_LEDGER = '.ploinky-skill-exports.json';
const exists = value => { try { fs.lstatSync(value); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

// Hash bytes, membership and modes; timestamps do not establish ownership.
export function skillTreeDigest(root) {
    const hash = crypto.createHash('sha256');
    const visit = (target, relative) => {
        const stat = fs.lstatSync(target);
        const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : '';
        if (!type) throw new Error(`Unsupported skill entry: ${target}`);
        hash.update(JSON.stringify([relative, type, stat.mode & 0o777]));
        if (type === 'file') hash.update(crypto.createHash('sha256').update(fs.readFileSync(target)).digest());
        if (type === 'symlink') hash.update(JSON.stringify(fs.readlinkSync(target)));
        if (type === 'directory') for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), `${relative}/${name}`);
    };
    visit(root, '');
    return hash.digest('hex');
}

function directory(target) {
    if (!exists(target)) fs.mkdirSync(target);
    if (!fs.lstatSync(target).isDirectory()) throw new Error(`Skill export directory must be a real directory: ${target}`);
}

export function copyFreshSkillTree(source, destination) {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { mode: 0o700 });
        for (const name of fs.readdirSync(source).sort()) copyFreshSkillTree(path.join(source, name), path.join(destination, name));
        fs.chmodSync(destination, stat.mode & 0o777);
    } else if (stat.isFile()) {
        // Create with owner access first; recursive native cp has exposed
        // transient unreadable modes on macOS virtiofs-backed Box mounts.
        fs.closeSync(fs.openSync(destination, 'wx', 0o600));
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, stat.mode & 0o777);
    } else if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
    else throw new Error(`Unsupported skill entry: ${source}`);
}

function readLedger(agents) {
    const filename = path.join(agents, EXPORT_LEDGER);
    if (!exists(filename)) return { version: 1, entries: Object.create(null) };
    if (!fs.lstatSync(filename).isFile()) throw new Error(`Skill ownership ledger is not a regular file: ${filename}`);
    const ledger = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (ledger.version !== 1 || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)) throw new Error(`Unsupported skill ownership ledger: ${filename}`);
    ledger.entries = Object.assign(Object.create(null), ledger.entries);
    return ledger;
}

/** Compatibility export only. Existing files are never adopted from names.
 * Retired trees stay outside the skill root, including for writes through old
 * open descriptors. A failed publication therefore never requires data loss.
 */
export function syncManagedSkillExports({ folder, owner, sources, beforeMove = null, afterMove = null }) {
    if (!owner || !Array.isArray(sources)) throw new Error('Skill exports require an owner and sources array');
    const incoming = new Map();
    for (const source of sources) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source.name)) throw new Error(`Invalid exported skill name: ${source.name}`);
        if (incoming.has(source.name)) throw new Error(`Duplicate exported skill name: ${source.name}`);
        incoming.set(source.name, source);
    }
    fs.mkdirSync(folder, { recursive: true });
    const root = fs.realpathSync(folder);
    const agents = path.join(root, '.agents');
    directory(agents);
    const skills = path.join(agents, 'skills');
    directory(skills);
    const lock = path.join(agents, '.ploinky-skill-exports.lock');
    try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Skill export already active (or interrupted; inspect lock): ${lock}`); throw error; }
    const result = { installed: [], removed: [], unchanged: [], diagnostics: [], backups: [] };
    const diagnose = (name, reason, extra = {}) => result.diagnostics.push({ name, reason, ...extra });
    let staging;
    try {
        const ledger = readLedger(agents);
        const stagingRoot = path.join(agents, '.ploinky-export-staging');
        const backupsRoot = path.join(agents, '.ploinky-export-backups');
        directory(stagingRoot);
        directory(backupsRoot);
        staging = fs.mkdtempSync(path.join(stagingRoot, 'export-'));
        const names = new Set([...incoming.keys(), ...Object.keys(ledger.entries).filter(name => ledger.entries[name].owner === owner)]);
        for (const name of names) {
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('Unsafe name in skill ownership ledger');
            const wanted = incoming.get(name);
            const record = ledger.entries[name];
            const destination = path.join(skills, name);
            const present = exists(destination);
            if (record && record.owner !== owner) { diagnose(name, 'owned-by-other-export'); continue; }
            if (present && !record) { diagnose(name, 'unrecorded-output-preserved'); continue; }
            if (!present && record && wanted) { diagnose(name, 'removed-output-preserved'); continue; }
            if (present && (!fs.lstatSync(destination).isDirectory() || skillTreeDigest(destination) !== record.digest)) { diagnose(name, 'edited-output-preserved'); continue; }
            let staged;
            let digest;
            if (wanted) {
                staged = path.join(staging, name);
                let valid = false;
                for (let attempt = 0; attempt < 3 && !valid; attempt++) {
                    const before = skillTreeDigest(wanted.path);
                    copyFreshSkillTree(wanted.path, staged);
                    digest = skillTreeDigest(staged);
                    valid = digest === before && digest === skillTreeDigest(wanted.path);
                    if (!valid) fs.rmSync(staged, { recursive: true, force: true });
                }
                if (!valid) { diagnose(name, 'source-changing-during-export'); continue; }
                if (record?.digest === digest) { result.unchanged.push(name); continue; }
            }
            let backup;
            if (present) {
                beforeMove?.({ name, destination });
                backup = path.join(backupsRoot, `${name}-${crypto.randomUUID()}`);
                fs.renameSync(destination, backup);
                result.backups.push(backup);
                afterMove?.({ name, destination, backup });
                // Recheck the moved tree to close the pre-rename edit window.
                if (skillTreeDigest(backup) !== record.digest) {
                    if (!exists(destination)) fs.renameSync(backup, destination);
                    diagnose(name, 'concurrent-edit-preserved', { backup: exists(backup) ? backup : null });
                    continue;
                }
            }
            if (wanted) {
                if (exists(destination)) { diagnose(name, 'concurrent-output-preserved', { backup }); continue; }
                try { fs.renameSync(staged, destination); }
                catch (error) { if (backup && !exists(destination)) fs.renameSync(backup, destination); throw error; }
                ledger.entries[name] = { owner, digest, source: wanted.source ?? null };
                result.installed.push(name);
            } else {
                delete ledger.entries[name];
                result.removed.push(name);
            }
        }
        const ledgerPath = path.join(agents, EXPORT_LEDGER);
        const temporary = path.join(staging, 'ledger.json');
        fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, ledgerPath);
        return result;
    } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true });
        fs.rmdirSync(lock);
    }
}
