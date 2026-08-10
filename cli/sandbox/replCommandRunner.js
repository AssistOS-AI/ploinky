// Runs one REPL command through the foreground coordinator so an active
// SIGINT cancels the command and returns to the prompt instead of exiting the
// shell, and so the command's numeric result reaches the caller. The REPL
// previously discarded that result, which made an interrupted or failed
// command indistinguishable from a successful one.
export async function runReplCommand({
    args,
    rl,
    stdin = process.stdin,
    handleCommandImpl,
    getPromptImpl,
    coordinator,
    onError = error => console.error('Error: ' + error.message),
    shouldPrompt = () => true,
}) {
    let code = 0;
    try {
        if (coordinator && args?.[0] === 'logs') {
            // The REPL owns the process-level handlers, so it routes signals
            // into the coordinator itself rather than having it install more.
            const outcome = await coordinator.run(
                () => handleCommandImpl(args),
                { installSignalHandlers: false },
            );
            code = outcome.code;
        } else {
            const result = await handleCommandImpl(args);
            code = Number.isInteger(result) ? result : 0;
        }
    } catch (error) {
        onError(error);
        code = 1;
    }
    if (shouldPrompt()) {
        rl.setPrompt(getPromptImpl());
        if (stdin.isTTY) rl.prompt();
    }
    return code;
}
