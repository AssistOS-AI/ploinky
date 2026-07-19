export async function runReplCommand({
    args,
    rl,
    stdin = process.stdin,
    handleCommandImpl,
    getPromptImpl,
    onError = error => console.error('Error: ' + error.message),
}) {
    try {
        await handleCommandImpl(args);
    } catch (error) {
        onError(error);
    }
    rl.setPrompt(getPromptImpl());
    if (stdin.isTTY) rl.prompt();
}
