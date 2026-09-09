// A disconnected control client owns only its worker, never the broker process.
export function connectRelayWorker(socket, worker, { stderr, onClose = () => {}, onExit = () => {} }) {
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        socket.unpipe(worker.stdin);
        worker.stdout.unpipe(socket);
        worker.stderr.unpipe(stderr);
        socket.destroy();
        worker.stdin.destroy();
        worker.stdout.destroy();
        worker.stderr.destroy();
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
    };
    // pipe() does not forward errors. Register every handler before piping,
    // including child stdin EPIPE when a short-lived readiness client leaves.
    socket.on('error', stop);
    worker.stdin.on('error', stop);
    worker.stdout.on('error', stop);
    worker.stderr.on('error', stop);
    worker.on('error', stop);
    socket.once('close', () => { onClose(); stop(); });
    worker.once('close', onExit);
    worker.once('exit', () => { if (!socket.destroyed) socket.end(); });
    socket.pipe(worker.stdin);
    worker.stdout.pipe(socket);
    worker.stderr.pipe(stderr, { end: false });
}
