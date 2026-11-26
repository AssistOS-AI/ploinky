import fs from 'node:fs';
import path from 'node:path';
import { assertNoRetiredControllerSecrets, readWorkspaceMasterKey } from './entrypoint/initialize-workspace.mjs';
import { deriveSubkeyFromSeed } from '../cli/utils/security/masterKey.js';
import { decryptSecretsText, SECRETS_STORAGE_SUBKEY_PURPOSE } from '../cli/utils/security/secretsFileCodec.js';
import { PloinkyBoxError } from './errors.mjs';
import { readPrivateFile } from './privateStateFiles.mjs';

// Passive host check for an owned Box that must be replaced. Never consult the
// shell or .env: managed Boxes use only their workspace master key.
export function assertNonProductionRecovery(workspaceRoot) {
    const file = path.join(workspaceRoot, '.ploinky', 'data', '.secrets');
    let raw;
    try {
        assertNoRetiredControllerSecrets(workspaceRoot);
        const legacyKey = path.join(workspaceRoot, '.ploinky', 'data', 'master-key');
        const currentKey = path.join(workspaceRoot, '.data', 'dpu-data', 'master-key');
        let legacyExists = false;
        let currentExists = false;
        try { fs.lstatSync(legacyKey); legacyExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { fs.lstatSync(currentKey); currentExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (legacyExists) {
            if (!currentExists) throw new Error('incomplete master key migration');
            readWorkspaceMasterKey({ workspaceRoot });
        }
        const directories = [workspaceRoot, path.join(workspaceRoot, '.ploinky'), path.join(workspaceRoot, '.ploinky', 'data')];
        const snapshots = directories.map(target => {
            const stat = fs.lstatSync(target);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid controller directory');
            return { dev: stat.dev, ino: stat.ino };
        });
        const bytes = readPrivateFile(fs, file, 8 * 1024 * 1024, 'controller variable store', {
            stateError: () => new Error('invalid controller variable store'),
        });
        directories.forEach((target, index) => {
            const stat = fs.lstatSync(target);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== snapshots[index].dev || stat.ino !== snapshots[index].ino) {
                throw new Error('controller directory changed');
            }
        });
        if (bytes === null) return;
        raw = bytes.toString('utf8').trim();
        if (!raw) throw new Error('controller store is empty');
    } catch (_) {
        throw new PloinkyBoxError('Recovery preflight cannot read the controller variable store; no runtime was changed.', { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    }
    let prod;
    let key;
    try {
        const seed = readWorkspaceMasterKey({ workspaceRoot }).key;
        key = deriveSubkeyFromSeed(seed, SECRETS_STORAGE_SUBKEY_PURPOSE);
        prod = decryptSecretsText(raw, key, { strict: true }).PROD;
    } catch (_) {
        throw new PloinkyBoxError('Recovery preflight cannot decrypt the controller variable store; no runtime was changed.', { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    } finally {
        key?.fill(0);
    }
    if (prod === undefined || prod === 'false') return;
    if (prod === 'true') {
        throw new PloinkyBoxError('Production recovery requires a trusted preflight of existing route provenance; it cannot be established with the current Box state. No runtime was changed.', { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    }
    throw new PloinkyBoxError('Recovery preflight found an invalid stored PROD value; no runtime was changed.', { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
}
