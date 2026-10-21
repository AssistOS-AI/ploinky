import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

// ZIP64 permits unknown sizes and more than 4 GiB without buffering file contents.
// Only central-directory records remain in memory (bounded to 100,000 entries).
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});
function crc32(chunk, previous) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(chunk, previous);
    let value = previous ^ 0xffffffff;
    for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function dosTime(mtime) {
    const date = new Date(Math.max(new Date(1980, 0, 1).getTime(), Math.min(mtime.getTime(), new Date(2107, 11, 31).getTime())));
    return [
        (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    ];
}

export async function* streamZip(entries) {
    let offset = 0n;
    let centralBytes = 0;
    const central = [];
    for await (const entry of entries) {
        if (central.length >= 100000) throw new Error('Folder exceeds the ZIP entry limit (100,000).');
        const name = Buffer.from(entry.name, 'utf8');
        centralBytes += 46 + name.length + 28;
        if (centralBytes > 32 * 1024 * 1024) throw new Error('Folder exceeds the ZIP metadata limit (32 MiB).');
        if (name.length > 65535 || entry.name.split('/').some(part => part === '..' || part === '.' || /[\\\0:]/.test(part))) {
            throw new Error('Unsupported archive entry name.');
        }
        const localOffset = offset;
        const method = entry.directory ? 0 : 8;
        const [time, date] = dosTime(entry.stat.mtime);
        const local = Buffer.alloc(30 + name.length + 20);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(45, 4);
        local.writeUInt16LE(0x0808, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(0xffffffff, 18);
        local.writeUInt32LE(0xffffffff, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(20, 28);
        name.copy(local, 30);
        local.writeUInt16LE(1, 30 + name.length);
        local.writeUInt16LE(16, 32 + name.length);
        yield local;
        offset += BigInt(local.length);

        let checksum = 0;
        let rawSize = 0n;
        let packedSize = 0n;
        if (!entry.directory) {
            const handle = await entry.open();
            let source;
            let compressor;
            let completion;
            try {
                source = handle.createReadStream({ autoClose: false });
                compressor = zlib.createDeflateRaw();
                const counter = new Transform({
                    transform(chunk, encoding, callback) {
                        rawSize += BigInt(chunk.length);
                        checksum = crc32(chunk, checksum);
                        callback(null, chunk);
                    }
                });
                completion = pipeline(source, counter, compressor);
                completion.catch(() => {});
                for await (const chunk of compressor) {
                    packedSize += BigInt(chunk.length);
                    offset += BigInt(chunk.length);
                    yield chunk;
                }
                await completion;
            } finally {
                source?.destroy();
                compressor?.destroy();
                await completion?.catch(() => {});
                if (handle.fd !== -1) await handle.close();
            }
        }
        const descriptor = Buffer.alloc(24);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(checksum, 4);
        descriptor.writeBigUInt64LE(packedSize, 8);
        descriptor.writeBigUInt64LE(rawSize, 16);
        yield descriptor;
        offset += BigInt(descriptor.length);

        const record = Buffer.alloc(46 + name.length + 28);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE((3 << 8) | 45, 4);
        record.writeUInt16LE(45, 6);
        record.writeUInt16LE(0x0808, 8);
        record.writeUInt16LE(method, 10);
        record.writeUInt16LE(time, 12);
        record.writeUInt16LE(date, 14);
        record.writeUInt32LE(checksum, 16);
        record.writeUInt32LE(0xffffffff, 20);
        record.writeUInt32LE(0xffffffff, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt16LE(28, 30);
        record.writeUInt32LE(((entry.stat.mode & 0xffff) * 65536 + (entry.directory ? 16 : 0)) >>> 0, 38);
        record.writeUInt32LE(0xffffffff, 42);
        name.copy(record, 46);
        const extra = 46 + name.length;
        record.writeUInt16LE(1, extra);
        record.writeUInt16LE(24, extra + 2);
        record.writeBigUInt64LE(rawSize, extra + 4);
        record.writeBigUInt64LE(packedSize, extra + 12);
        record.writeBigUInt64LE(localOffset, extra + 20);
        central.push(record);
    }
    const centralOffset = offset;
    for (const record of central) {
        yield record;
        offset += BigInt(record.length);
    }
    const end = Buffer.alloc(56 + 20 + 22);
    end.writeUInt32LE(0x06064b50, 0);
    end.writeBigUInt64LE(44n, 4);
    end.writeUInt16LE(45, 12);
    end.writeUInt16LE(45, 14);
    end.writeBigUInt64LE(BigInt(central.length), 24);
    end.writeBigUInt64LE(BigInt(central.length), 32);
    end.writeBigUInt64LE(offset - centralOffset, 40);
    end.writeBigUInt64LE(centralOffset, 48);
    end.writeUInt32LE(0x07064b50, 56);
    end.writeBigUInt64LE(offset, 64);
    end.writeUInt32LE(1, 72);
    end.writeUInt32LE(0x06054b50, 76);
    end.writeUInt16LE(0xffff, 84);
    end.writeUInt16LE(0xffff, 86);
    end.writeUInt32LE(0xffffffff, 88);
    end.writeUInt32LE(0xffffffff, 92);
    yield end;
}

export function createZipStream(entries) {
    return Readable.from(streamZip(entries), { objectMode: false });
}
