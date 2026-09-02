import { isInsideBox } from './boxMarker.mjs';

const HTTP1_PARAMETER = "'http.version=HTTP/1.1'";

/**
 * Apply the Box's Git transport to its CLI and lifecycle children. This is
 * process-scoped: the physical host's Git configuration remains untouched.
 * Git's legacy parameter format is also supported by older installer tools.
 */
export function initializeBoxGitTransport({ env = process.env, insideBox = isInsideBox() } = {}) {
    if (!insideBox) return env;
    const parameters = String(env.GIT_CONFIG_PARAMETERS || '').trim();
    // CLI re-entry must not grow an identical configuration suffix forever.
    if (parameters === HTTP1_PARAMETER || parameters.endsWith(` ${HTTP1_PARAMETER}`)) return env;
    env.GIT_CONFIG_PARAMETERS = parameters ? `${parameters} ${HTTP1_PARAMETER}` : HTTP1_PARAMETER;
    return env;
}
