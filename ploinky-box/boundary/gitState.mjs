import { runProcess } from '../process.mjs';

function splitNullTerminated(output) {
    const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
    if (bytes.length === 0) {
        return [];
    }
    if (bytes.at(-1) !== 0) {
        throw new Error('Expected NUL-terminated Git output');
    }
    return bytes.subarray(0, -1).toString('utf8').split('\0');
}

export function runGit(repositoryRoot, args, options = {}) {
    return runProcess('git', ['-C', repositoryRoot, ...args], options);
}

export function readChangedPaths(repositoryRoot, baseSha) {
    const output = runGit(repositoryRoot, [
        'diff',
        '--name-status',
        '-z',
        baseSha,
    ]);
    const tokens = splitNullTerminated(output);
    const paths = new Set();

    for (let index = 0; index < tokens.length;) {
        const status = tokens[index];
        index += 1;
        if (!status) {
            throw new Error('Git emitted an empty name-status token');
        }

        if (status.startsWith('R') || status.startsWith('C')) {
            if (index + 1 >= tokens.length) {
                throw new Error(`Git emitted an incomplete ${status} record`);
            }
            paths.add(tokens[index]);
            paths.add(tokens[index + 1]);
            index += 2;
            continue;
        }

        if (index >= tokens.length) {
            throw new Error(`Git emitted an incomplete ${status} record`);
        }
        paths.add(tokens[index]);
        index += 1;
    }

    const untracked = splitNullTerminated(runGit(repositoryRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
    ]));
    for (const relativePath of untracked) {
        paths.add(relativePath);
    }

    return paths;
}

export function readDirtyEntries(repositoryRoot) {
    const output = runGit(repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
    ]);
    const tokens = splitNullTerminated(output);
    const entries = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.length < 4 || token[2] !== ' ') {
            throw new Error(`Git emitted an invalid porcelain record: ${token}`);
        }
        const status = token.slice(0, 2);
        const entry = {
            path: token.slice(3),
            status,
        };
        if (status.includes('R') || status.includes('C')) {
            if (index + 1 >= tokens.length) {
                throw new Error(`Git emitted an incomplete ${status} record`);
            }
            entry.originalPath = tokens[index + 1];
            index += 1;
        }
        entries.push(entry);
    }

    return entries;
}
