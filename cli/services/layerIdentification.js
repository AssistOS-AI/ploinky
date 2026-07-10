export function formatOuterRuntimeBanner({ runtimeName, user, cwd = '/workspace' }) {
    return [
        "[ploinky] Entering outer runtime '" + runtimeName + "'",
        '[ploinky] user=' + user + ' cwd=' + cwd + '; exit returns to the previous prompt',
    ];
}
