import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECRETS_FILE } from '../../cli/utils/config.js';
import { decryptSecretsText } from '../../cli/utils/security/encryptedSecretsFile.js';
import { imageRefreshPolicyFromSecrets } from '../../cli/sandbox/docker/imageRefreshPolicy.mjs';

// Read-only: the host never decrypts the workspace secrets, so it asks this program inside the Box.
// `unknown` means the policy could not be read (unreadable or undecryptable file). It never writes.
export function readImageRefreshPolicyFile(file = SECRETS_FILE, { fsApi = fs, decrypt = decryptSecretsText } = {}) {
    let raw = '';
    try {
        raw = fsApi.readFileSync(file, 'utf8').trim();
    } catch (error) {
        if (error?.code !== 'ENOENT') return { policy: 'unknown' };
    }
    try {
        return { policy: imageRefreshPolicyFromSecrets(raw ? decrypt(raw) : {}).policy };
    } catch (_) {
        return { policy: 'unknown' };
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.stdout.write(`${JSON.stringify(readImageRefreshPolicyFile())}\n`);
}
