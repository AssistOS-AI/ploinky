import fs from 'fs';
import path from 'path';

const HISTORY_DIR_NAME = '.copilot_history';
const STORE_GITIGNORE = '*\n!.gitignore\n';

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function ensureTaskHistoryDirectory(workspaceDirectory) {
    const requested = path.resolve(String(workspaceDirectory || ''));
    const workspace = fs.realpathSync(requested);
    if (!fs.statSync(workspace).isDirectory()) throw new Error('invalid_workspace_directory');

    const historyDirectory = path.join(workspace, HISTORY_DIR_NAME);
    try {
        const stat = fs.lstatSync(historyDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_history_directory');
        if (!isInside(workspace, fs.realpathSync(historyDirectory))) throw new Error('unsafe_history_directory');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fs.mkdirSync(historyDirectory, { recursive: false, mode: 0o700 });
    }

    const gitignorePath = path.join(historyDirectory, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, STORE_GITIGNORE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    return { workspace, historyDirectory };
}
