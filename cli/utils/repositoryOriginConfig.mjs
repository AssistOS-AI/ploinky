import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// null means Git must interpret the config. Validate all lines, not just origin:
// Git rejects a bad escape or malformed section even after a valid origin URL.
function parseOrigin(config) {
    const text = config.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (text.includes('\0')) return null;
    let section = '';
    let subsection = '';
    let origin = null;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index].replace(/^[ \t]+/, '');
        if (!line || /^[#;]/.test(line)) continue;
        if (line.startsWith('[')) {
            const header = /^\[([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?[ \t]*\]/.exec(line);
            if (!header) return null;
            section = header[1].toLowerCase();
            subsection = header[2] === undefined ? '' : header[2].replace(/\\(.)/g, '$1');
            if (header[2] === undefined && section.includes('.')) {
                const dot = section.indexOf('.');
                subsection = section.slice(dot + 1);
                section = section.slice(0, dot);
            }
            if (section === 'include' || section === 'includeif') return null;
            line = line.slice(header[0].length).replace(/^[ \t]+/, '');
            if (!line || /^[#;]/.test(line)) continue;
        }
        if (!section) return null;
        const variable = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=(.*)|([#;].*)?)$/.exec(line);
        if (!variable) return null;
        const key = variable[1].toLowerCase();
        if (section === 'extensions' && !subsection && key === 'worktreeconfig') return null;
        let value = '';
        let pendingSpace = '';
        let quoted = false;
        let input = variable[2] ?? '';
        for (let cursor = 0; cursor < input.length; cursor += 1) {
            const char = input[cursor];
            if (!quoted && (char === '#' || char === ';')) break;
            if (char === '\\') {
                if (cursor + 1 === input.length) {
                    if (++index === lines.length) return null;
                    input += lines[index];
                    continue;
                }
                const escaped = input[++cursor];
                const escapes = { n: '\n', t: '\t', b: '\b', '"': '"', '\\': '\\' };
                if (!Object.hasOwn(escapes, escaped)) return null;
                value += pendingSpace + escapes[escaped];
                pendingSpace = '';
            } else if (char === '"') {
                value += pendingSpace;
                pendingSpace = '';
                quoted = !quoted;
            } else if (!quoted && (char === ' ' || char === '\t')) {
                if (value) pendingSpace += char;
            } else {
                value += pendingSpace + char;
                pendingSpace = '';
            }
        }
        if (quoted) return null;
        if (section === 'remote' && subsection === 'origin' && key === 'url') origin = value;
    }
    return origin;
}

export function readOriginFromGitConfig(directory) {
    const gitDirectory = path.join(directory, '.git');
    if (!fs.existsSync(gitDirectory)) return '';
    try {
        // Ownership refusal must remain Git's decision, including safe.directory.
        const uid = process.geteuid?.();
        const repository = fs.lstatSync(directory);
        const git = fs.lstatSync(gitDirectory);
        const overridden = Object.keys(process.env).some(key => key === 'GIT_DIR' || key === 'GIT_CONFIG' || key.startsWith('GIT_CONFIG_'));
        if (!overridden && uid !== undefined && repository.isDirectory() && git.isDirectory()
            && repository.uid === uid && git.uid === uid) {
            const origin = parseOrigin(fs.readFileSync(path.join(gitDirectory, 'config'), 'utf8'));
            if (origin !== null) return origin;
        }
    } catch { /* Git preserves the existing failure and special-checkout behavior. */ }
    try {
        return execFileSync('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
        }).replace(/\n$/, '');
    } catch { return ''; }
}
