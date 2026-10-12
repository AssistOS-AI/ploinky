import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// QA ancestry and permissions were captured read-only on 2026-10-12.
// The libkrun tree models the 2026-10-12 ploinky-gpu capture; AMD remains synthetic.
export function makeTree(t, kind = 'amd', overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-query-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['dev/dri', 'sys/class/drm', 'sys/bus/pci/devices', 'proc/sys/kernel', '.stat', 'bin']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.copyFileSync(fileURLToPath(new URL('./stat-shim.sh', import.meta.url)), `${root}/bin/stat`);
    fs.chmodSync(`${root}/bin/stat`, 0o755);
    fs.writeFileSync(`${root}/proc/sys/kernel/osrelease`, os.release());
    function addNode(options = {}) {
        const { name = 'renderD128', mode = kind === 'qa' ? 0o20660 : 0o20666,
            major = 226, minor = Number(name.slice(7)), sysDev = `226:${minor}`,
            transport = kind === 'qa' ? 'virtio-pci' : kind === 'krun' ? 'virtio-mmio' : 'amdgpu',
            vendor = kind === 'qa' ? '0x1af4' : kind === 'krun' ? null : '0x1002',
            vramBytes = ['qa', 'krun'].includes(kind) ? null : '8589934592',
            children = ['qa', 'krun'].includes(kind) ? [{ name: kind === 'krun' ? 'virtio3' : 'virtio10', driver: 'virtio_gpu', device: '0x0010' }] : [],
            stat = true, link = false } = options;
        const device = `${root}/sys/devices/${name}`;
        fs.mkdirSync(device, { recursive: true });
        fs.mkdirSync(`${root}/sys/class/drm/${name}`, { recursive: true });
        fs.symlinkSync(device, `${root}/sys/class/drm/${name}/device`);
        fs.writeFileSync(`${root}/sys/class/drm/${name}/dev`, sysDev);
        if (link) {
            fs.writeFileSync(`${root}/dev/target`, '');
            fs.symlinkSync(`${root}/dev/target`, `${root}/dev/dri/${name}`);
        } else fs.writeFileSync(`${root}/dev/dri/${name}`, '');
        if (stat) fs.writeFileSync(`${root}/.stat/${name}`, `${mode.toString(16)} ${major.toString(16)} ${minor.toString(16)}\n`);
        function bindDriver(target, driver) {
            if (!driver) return;
            fs.mkdirSync(`${root}/sys/drivers/${driver}`, { recursive: true });
            fs.symlinkSync(`${root}/sys/drivers/${driver}`, `${target}/driver`);
        }
        bindDriver(device, transport);
        if (vendor !== null) fs.writeFileSync(`${device}/vendor`, vendor);
        if (vramBytes !== null) fs.writeFileSync(`${device}/mem_info_vram_total`, vramBytes);
        for (const child of children) {
            fs.mkdirSync(`${device}/${child.name}`, { recursive: true });
            bindDriver(`${device}/${child.name}`, child.driver);
            if (child.device) fs.writeFileSync(`${device}/${child.name}/device`, child.device);
        }
    }
    if (kind !== 'empty') addNode({ ...overrides });
    const fsApi = Object.create(fs);
    fsApi.lstatSync = (target) => {
        if (!String(target).startsWith(`${root}/dev/dri/`)) return fs.lstatSync(target);
        const [mode, major, minor] = fs.readFileSync(`${root}/.stat/${path.basename(target)}`, 'utf8').trim().split(' ').map((v) => parseInt(v, 16));
        const rdev = (BigInt(major) << 8n) | (BigInt(minor) & 0xffn) | ((BigInt(minor) & ~0xffn) << 12n);
        return { mode, rdev };
    };
    return { root, fsApi, addNode };
}
