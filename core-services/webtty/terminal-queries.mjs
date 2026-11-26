// A program asks the terminal it is attached to about itself - the palette, the default foreground, background and
// cursor colours, the cursor position, the device attributes - and the terminal answers on the same standard input
// the program types on. Only a terminal that is attached when the program asks can be that terminal: a question is
// a request for one answer, not something to hand to a terminal that arrives later.
//
// A session keeps its output so a terminal that joins a running conversation can be caught up. Those retained bytes
// still carry the questions of whoever was attached at the time, so a catch-up stream has to leave them out: any
// terminal that reads them answers them, and its answers reach the program as typed text, which is how a palette
// report like `0;rgb:1717/1414/2121` ends up in the program's own prompt.

// OSC 4/10/11/12 and 110-119 with a `?` payload, DSR 6 for the cursor position, DA1 and DA2 for device attributes.
const TERMINAL_QUERIES = /\u001b\](?:1[012]|4|1[01][0-9]);?[^\u0007\u001b]*\?(?:\u0007|\u001b\\)|\u001b\[6n|\u001b\[[>?]?[0-9]?c/gu;

// The front of a question still arriving at the end of an output chunk. A question the pty handed over in two
// reads is held until the chunk that completes it arrives, so neither half reaches the catch-up on its own.
const UNFINISHED_QUERY = /\u001b$|\u001b\][^\u0007\u001b]{0,256}(?:\u001b)?$|\u001b\[[0-9;>?]{0,32}$/u;

// One stripper per catch-up stream: the held bytes belong to the order the output arrived in.
export function createTerminalQueryStripper() {
    let held = '';
    return function stripQueries(data) {
        const text = held + data;
        held = '';
        const stripped = text.replace(TERMINAL_QUERIES, '');
        const unfinished = UNFINISHED_QUERY.exec(stripped);
        if (!unfinished) return stripped;
        held = unfinished[0];
        return stripped.slice(0, unfinished.index);
    };
}
