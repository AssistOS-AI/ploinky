import nodeFs from 'node:fs';
// Test-only in-memory filesystem with the small synchronous surface the probes and readers use.
export function createMemoryFs(initial = {}) {
    const files = new Map(Object.entries(initial).map(([name, value]) => [name, Buffer.from(value)])), open = new Map(); let next = 100, inode = 10;
    const overrideLinks = new Map(); const inodes = new Map(); const ino = name => { if (!inodes.has(name)) inodes.set(name, inode++); return inodes.get(name); };
    const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const isDir = name => [...files.keys()].some(file => file.startsWith(`${name}/`));
    const stat = name => {
        if (files.has(name)) { const bytes = files.get(name); return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: bytes.length, dev: 1, ino: ino(name), uid: 1000, mode: 0o100644, nlink: overrideLinks.get(name) ?? 1 }; }
        if (isDir(name)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, dev: 1, ino: ino(name), mode: 0o040755, nlink: 2 };
        throw missing();
    };
    return { files, overrideLinks, replaceInode: name => { inodes.set(name, inode++); }, lstatSync: stat, statSync: stat, unlinkSync: name => { if (!files.has(name)) throw missing(); files.delete(name); }, setFile: (name, value) => { files.set(name, Buffer.from(value)); },
        openSync: (name, flags = 0) => {
            // Write-create with O_EXCL refuses an existing file exactly as the real exclusive create does.
            const { O_WRONLY, O_RDWR, O_CREAT, O_EXCL } = nodeFs.constants;
            if ((flags & (O_WRONLY | O_RDWR)) !== 0 && (flags & O_CREAT) !== 0) { if (files.has(name) && (flags & O_EXCL) !== 0) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); if (!files.has(name)) files.set(name, Buffer.alloc(0)); }
            else if (!files.has(name)) throw missing();
            const fd = next++; open.set(fd, { name, offset: 0 }); return fd; },
        writeSync: (fd, bytes, offset, length) => { const state = open.get(fd); files.set(state.name, Buffer.concat([files.get(state.name), Buffer.from(bytes.subarray(offset, offset + length))])); return length; },
        fstatSync: fd => stat(open.get(fd).name),
        readSync: (fd, buffer, start, length) => { const state = open.get(fd), bytes = files.get(state.name), count = Math.min(length, bytes.length - state.offset); bytes.copy(buffer, start, state.offset, state.offset + count); state.offset += count; return count; },
        closeSync: fd => { open.delete(fd); },
        readdirSync: name => { const prefix = `${name}/`, names = new Set(); for (const file of files.keys()) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]); if (!names.size) throw missing(); return [...names]; } };
}
