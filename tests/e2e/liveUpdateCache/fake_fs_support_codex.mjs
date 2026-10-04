// Test-only in-memory filesystem with the small synchronous surface the probes and readers use.
export function createMemoryFs(initial = {}) {
    const files = new Map(Object.entries(initial).map(([name, value]) => [name, Buffer.from(value)])), open = new Map(); let next = 100, inode = 10;
    const inodes = new Map(); const ino = name => { if (!inodes.has(name)) inodes.set(name, inode++); return inodes.get(name); };
    const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const isDir = name => [...files.keys()].some(file => file.startsWith(`${name}/`));
    const stat = name => {
        if (files.has(name)) { const bytes = files.get(name); return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: bytes.length, dev: 1, ino: ino(name), mode: 0o100644, nlink: 1 }; }
        if (isDir(name)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, dev: 1, ino: ino(name), mode: 0o040755, nlink: 2 };
        throw missing();
    };
    return { files, lstatSync: stat, statSync: stat,
        openSync: name => { if (!files.has(name)) throw missing(); const fd = next++; open.set(fd, { name, offset: 0 }); return fd; },
        fstatSync: fd => stat(open.get(fd).name),
        readSync: (fd, buffer, start, length) => { const state = open.get(fd), bytes = files.get(state.name), count = Math.min(length, bytes.length - state.offset); bytes.copy(buffer, start, state.offset, state.offset + count); state.offset += count; return count; },
        closeSync: fd => { open.delete(fd); },
        readdirSync: name => { const prefix = `${name}/`, names = new Set(); for (const file of files.keys()) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]); if (!names.size) throw missing(); return [...names]; } };
}
