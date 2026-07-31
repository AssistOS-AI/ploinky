const LOG_END_TOLERANCE_PX = 2;

function isAtLogEnd(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= LOG_END_TOLERANCE_PX;
}

export function createTaskLogFollower(log) {
    let following = true;
    let previousScrollTop = log.scrollTop;

    log.addEventListener('scroll', () => {
        const currentScrollTop = log.scrollTop;
        if (currentScrollTop < previousScrollTop) following = false;
        else if (isAtLogEnd(log)) following = true;
        previousScrollTop = currentScrollTop;
    });

    return {
        restoreAfterRender(savedScrollTop) {
            log.scrollTop = following ? log.scrollHeight : savedScrollTop;
            previousScrollTop = log.scrollTop;
        },
    };
}
