export function buildAgentShellArgs(command, shellPath = 'sh') {
    // Login profiles can reset HOME and source project files from /root before
    // the command runs. Inherit the admitted image/runtime environment instead.
    return [shellPath, '-c', command];
}
