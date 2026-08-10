export function cleanupWhenResponseCloses(res, cleanup) {
    let cleaned = false;
    const run = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup();
    };
    res.once('close', run);
    return run;
}

export default cleanupWhenResponseCloses;
