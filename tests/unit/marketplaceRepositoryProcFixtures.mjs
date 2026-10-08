// Shared in-memory /proc fixture for the repository process observer. This is
// not a test file, so importing it registers no tests.
export function procFixture() {
    const processes = new Map();
    let handles = 0;
    let opens = 0;
    let mutate = () => {};
    let beforeOpen = async () => {};
    function add(pid, options = {}) {
        processes.set(pid, { pid, birth: `${pid}00`, parent: 1, group: pid, session: pid,
            state: 'S', namespace: 'pid:[42]', uid: 1000, argv: ['/node', '/supervisor.mjs'],
            env: [], ...options });
    }
    function value(pid, name) {
        const record = processes.get(pid);
        if (!record) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        if (record.unreadable === name) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
        if (name === 'stat') return Buffer.from(`${pid} (fixture (name)) ${record.state} ${record.parent} ${record.group} ${record.session} ${Array(15).fill('0').join(' ')} ${record.birth}\n`);
        if (name === 'status') return Buffer.from(`Uid:\t${Array(4).fill(record.uid).join('\t')}\n`);
        if (name === 'cmdline') return Buffer.from(record.argv.length ? `${record.argv.join('\0')}\0` : '');
        if (name === 'environ') return Buffer.from(record.env.length ? `${record.env.join('\0')}\0` : '');
        throw new Error(`unexpected field ${name}`);
    }
    const fsApi = {
        async opendir() {
            const entries = [...processes.keys()].map((pid) => ({ name: String(pid) }));
            handles += 1;
            return { async read() { return entries.shift() || null; }, async close() { handles -= 1; } };
        },
        async open(file) {
            const [, pid, name] = file.match(/\/([0-9]+)\/(.+)$/);
            await beforeOpen(Number(pid), name);
            const bytes = value(Number(pid), name);
            opens += 1;
            handles += 1;
            mutate(Number(pid), name);
            return {
                async read(target, offset, length, position) {
                    const part = bytes.subarray(position, position + length);
                    part.copy(target, offset);
                    return { bytesRead: part.length };
                },
                async close() { handles -= 1; },
            };
        },
        async readlink(file) {
            const [, pid, name] = file.match(/\/([0-9]+)\/(.+)$/);
            const record = processes.get(Number(pid));
            if (!record) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (record.unreadable === name) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
            return name === 'exe' ? '/node' : record.namespace;
        },
    };
    return { fsApi, processes, add, setMutate: (fn) => { mutate = fn; },
        setBeforeOpen: (fn) => { beforeOpen = fn; }, handles: () => handles, opens: () => opens };
}
