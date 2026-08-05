function cliArgumentError(message, code = 'PLOINKY_CLI_ARGUMENT_INVALID') {
    const error = new Error(message);
    error.code = code;
    error.status = 400;
    return error;
}

function normalizeLexicalWorkdir(value) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
        throw cliArgumentError('cli --workdir requires a non-empty path', 'PLOINKY_WORKDIR_INVALID');
    }
    const segments = value.split('/');
    if (segments.includes('..')) {
        throw cliArgumentError('cli --workdir does not permit traversal segments', 'PLOINKY_WORKDIR_INVALID');
    }
    const withoutTrailingSlashes = value.replace(/\/+$/, '') || '/';
    if (withoutTrailingSlashes === '/workspace'
        || withoutTrailingSlashes === '.'
        || withoutTrailingSlashes === './') {
        throw cliArgumentError('cli --workdir cannot select the workspace root', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN');
    }
    if (value.startsWith('-')) {
        throw cliArgumentError('cli --workdir path is ambiguous with a CLI option', 'PLOINKY_WORKDIR_INVALID');
    }
    return value;
}

export function parseAgentCliArguments(argv) {
    if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
        throw new TypeError('Agent CLI arguments must be an array of strings');
    }
    const [agent, ...tail] = argv;
    if (!agent || agent !== agent.trim() || agent.startsWith('-')) {
        throw cliArgumentError('cli requires one exact agent selector');
    }
    if (tail[0] !== '--workdir') {
        if (tail[0]?.startsWith('--workdir=')) {
            throw cliArgumentError('cli requires --workdir and its path as separate arguments');
        }
        throw cliArgumentError(
            'cli requires --workdir <path> before --',
            'PLOINKY_WORKDIR_REQUIRED',
        );
    }
    if (tail.length < 2 || tail[1] === '--') {
        throw cliArgumentError(
            'cli --workdir requires a path',
            'PLOINKY_WORKDIR_REQUIRED',
        );
    }
    const workdir = normalizeLexicalWorkdir(tail[1]);
    const separatorIndex = tail.indexOf('--', 2);
    if (separatorIndex < 0) {
        throw cliArgumentError(
            'cli requires -- before provider arguments',
            'PLOINKY_CLI_SEPARATOR_REQUIRED',
        );
    }
    if (separatorIndex !== 2) {
        throw cliArgumentError(
            `cli accepts exactly one pre-separator selector: --workdir <path>`,
        );
    }
    return Object.freeze({
        agent,
        workdir,
        providerArgv: Object.freeze(tail.slice(separatorIndex + 1)),
    });
}
