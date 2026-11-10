import base64
import ctypes
import errno
import json
import linecache
import os
import re
import select
import sys
import tokenize
import traceback

libc = ctypes.CDLL(None, use_errno=True)
libc.setns.argtypes = [ctypes.c_int, ctypes.c_int]
libc.setns.restype = ctypes.c_int
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.umount2.restype = ctypes.c_int
libc.ioctl.restype = ctypes.c_int
OPEN_TREE_FLAGS = 1 | 0x1000 | 0x800 | os.O_CLOEXEC
MOVE_FLAGS = 0x4 | 0x40
NEWUSER = 0x10000000
NEWNS = 0x00020000
fds = []
created = None
mount_id = None
attached = False
in_target_ns = False
config = None


def fail(message):
    raise RuntimeError(message)


def require(condition, message):
    if not condition:
        fail(message)


def checked(name, result):
    if result == -1:
        code = ctypes.get_errno()
        raise OSError(code, f'{name}: {errno.errorcode.get(code, "UNKNOWN")}')
    return result


def save(fd):
    fds.append(fd)
    return fd


def ident(fd):
    value = os.fstat(fd)
    return {'dev': str(value.st_dev), 'ino': str(value.st_ino)}


def ident_at(fd, name, follow=True):
    value = os.stat(name, dir_fd=fd, follow_symlinks=follow)
    return {'dev': str(value.st_dev), 'ino': str(value.st_ino)}


def read_at(fd, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=fd)
    with os.fdopen(descriptor, 'r', encoding='utf8') as stream:
        return stream.read()


def walk(root, parts):
    current = os.dup(root)
    try:
        for part in parts:
            require(part not in ('', '.', '..'), 'invalid path')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def token():
    value = read_at(proc_fd, 'stat')
    return 'linux-proc:' + value[value.rfind(')') + 2:].split(' ')[19]


def mountinfo():
    return [line.split(' - ', 1)[0].split(' ') for line in read_at(proc_fd, 'mountinfo').splitlines()]


def mounts_at():
    return [item for item in mountinfo() if item[4] == destination]


def mountid(fd):
    for line in read_at(self_fd, f'fdinfo/{fd}').splitlines():
        if line.startswith('mnt_id:'):
            return line.split(':', 1)[1].strip()
    fail('missing mount id')


def private(entries):
    return not any(re.search(r'^(shared|master|propagate_from):\d+$', item) for entry in entries for item in entry[6:])


def revalidate(source=False):
    require(token() == expected_start, 'target start changed')
    require(ident(proc_fd) == ident_at(proc_root_fd, str(pid)), 'target process changed')
    require(ident(root_fd) == ident_at(proc_fd, 'root'), 'target root changed')
    require(ident(mount_ns_fd) == ident_at(proc_fd, 'ns/mnt'), 'target mount namespace changed')
    require(ident(user_ns_fd) == ident_at(proc_fd, 'ns/user'), 'target user namespace changed')
    require(ident(run_fd) == ident_at(root_fd, 'run', False), 'target parent changed')
    if source:
        require(ident(source_fd) == ident_at(source_parent_fd, source_leaf, False), 'source changed')


def emit(phase, **values):
    print(json.dumps({'phase': phase, **values}, separators=(',', ':')), flush=True)


def command(expected):
    ready, _, _ = select.select([sys.stdin], [], [], 60)
    require(bool(ready), 'broker timed out')
    line = sys.stdin.readline()
    require(bool(line), 'broker closed')
    value = json.loads(line)
    if value == {'action': 'abort'}:
        fail('broker aborted')
    require(value == {'action': expected}, 'invalid broker command')


def enter_target():
    global in_target_ns
    if in_target_ns:
        return
    if ident_at(self_fd, 'ns/user') != ident(owner_fd):
        ctypes.set_errno(0)
        checked('setns user', libc.setns(owner_fd, NEWUSER))
    require(ident_at(self_fd, 'ns/user') == ident(owner_fd), 'wrong owner namespace')
    ctypes.set_errno(0)
    checked('setns mount', libc.setns(mount_ns_fd, NEWNS))
    require(ident_at(self_fd, 'ns/mnt') == ident(mount_ns_fd), 'wrong mount namespace')
    in_target_ns = True


def cleanup(expected_directory, expected_mount, expected_source):
    revalidate()
    entries = mounts_at()
    if entries:
        require(expected_mount is not None and len(entries) == 1 and entries[0][0] == expected_mount, 'unexpected target mount')
        enter_target()
        mounted_fd = save(walk(root_fd, ['run', name]))
        require(mountid(mounted_fd) == expected_mount and ident(mounted_fd) == expected_source, 'mounted identity changed')
        os.fchdir(mounted_fd)
        try:
            require(ident_at(cwd_fd, '.') == ident(cwd_fd), 'saved cwd changed')
            require(ident_at(mounted_fd, '.') == ident(mounted_fd), 'mounted cwd changed')
            ctypes.set_errno(0)
            checked('umount2', libc.umount2(b'.', 2))
        finally:
            os.fchdir(cwd_fd)
        require(not mounts_at(), 'mount still present')
    else:
        require(expected_mount is None or not entries, 'mount unavailable')
    try:
        directory_fd = save(walk(root_fd, ['run', name]))
    except FileNotFoundError:
        return
    require(expected_directory is not None, 'unknown destination inode')
    require(ident(directory_fd) == expected_directory and os.listdir(directory_fd) == [], 'destination identity changed')
    require(ident_at(run_fd, name, False) == expected_directory, 'destination entry changed')
    os.rmdir(name, dir_fd=run_fd)
    try:
        os.stat(name, dir_fd=run_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    fail('destination still exists')


try:
    libc.open_tree.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    libc.open_tree.restype = ctypes.c_int
    libc.move_mount.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    libc.move_mount.restype = ctypes.c_int
    require(len(sys.argv) == 3 and re.fullmatch(r'[A-Za-z0-9_-]{32}', sys.argv[1]), 'invalid helper arguments')
    raw = sys.argv[2]
    config = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
    operation = config['operation']
    require(operation in ('prepare', 'validate', 'release'), 'invalid operation')
    receipt = config.get('receipt')
    if operation == 'prepare':
        pid = config['initPid']
        expected_start = config['initStart']
        destination = config['destination']
        source_identity = config['sourceIdentity']
    else:
        pid = receipt['target']['initPid']
        expected_start = receipt['target']['initStart']
        destination = receipt['destination']['path']
        source_identity = receipt['source']
    require(type(pid) is int and pid > 1 and re.fullmatch(r'linux-proc:[1-9][0-9]*', expected_start), 'invalid target')
    require(re.fullmatch(r'/run/ploinky-webtty-home-[A-Za-z0-9_-]{32}', destination), 'invalid destination')
    require(os.getuid() == 0, 'not in rootless unshare')
    name = destination.rsplit('/', 1)[1]
    proc_root_fd = save(os.open('/proc', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
    self_fd = save(os.open('self', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=proc_root_fd))
    cwd_fd = save(os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
    task_fd = save(os.open('task', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=self_fd))
    require(len(os.listdir(task_fd)) == 1, 'helper is not single threaded')
    proc_fd = save(os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=proc_root_fd))
    require(token() == expected_start, 'target process changed')
    root_fd = save(os.open('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=proc_fd))
    mount_ns_fd = save(os.open('ns/mnt', os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_fd))
    user_ns_fd = save(os.open('ns/user', os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_fd))
    ctypes.set_errno(0)
    owner_fd = save(checked('mount owner', libc.ioctl(ctypes.c_int(mount_ns_fd), ctypes.c_ulong(0xb701))))
    run_fd = save(walk(root_fd, ['run']))
    root_stat = os.fstat(root_fd)
    run_stat = os.fstat(run_fd)
    root_mapping = [line.split() for line in read_at(proc_fd, 'uid_map').splitlines() if line.split() and line.split()[0] == '0']
    require(len(root_mapping) == 1 and len(root_mapping[0]) == 3, 'target root mapping unavailable')
    mapped_root = int(root_mapping[0][1])
    require(root_stat.st_uid == mapped_root and run_stat.st_uid == mapped_root and run_stat.st_mode & 0o022 == 0, 'unprotected target parent')
    require(mountid(run_fd) == mountid(root_fd), 'target parent is a separate mount')
    require(private(mountinfo()), 'target mount propagation is not private')
    target = {'root': ident(root_fd), 'mountNamespace': ident(mount_ns_fd), 'userNamespace': ident(user_ns_fd), 'mountOwner': ident(owner_fd)}
    if operation != 'prepare':
        # The broker records this helper's verified identity before allowing
        # any receipt check, unmount or directory removal.
        emit('identity', target=target)
        command('proceed')
    revalidate()
    if operation != 'prepare':
        require(all(receipt['target'][key] == value for key, value in target.items()), 'target identity does not match receipt')
        stage = receipt['stage']
        expected_directory = None if stage == 'intent' else {'dev': receipt['destination']['dev'], 'ino': receipt['destination']['ino']}
        expected_mount = receipt.get('mountId')
        if operation == 'release':
            cleanup(expected_directory, expected_mount, source_identity)
        else:
            require(stage == 'attached', 'not attached')
            entries = mounts_at()
            require(len(entries) == 1 and entries[0][0] == expected_mount, 'mount id mismatch')
            mounted_fd = save(walk(root_fd, ['run', name]))
            require(mountid(mounted_fd) == expected_mount and ident(mounted_fd) == source_identity, 'source mount changed')
        emit('closed')
    else:
        source = config['source']
        require(isinstance(source, str) and source.startswith('/') and os.path.normpath(source) == source, 'invalid source')
        slash_fd = save(os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
        parts = source.split('/')[1:]
        source_parent_fd = save(walk(slash_fd, parts[:-1]))
        source_leaf = parts[-1]
        source_fd = save(os.open(source_leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source_parent_fd))
        require(ident(source_fd) == source_identity, 'source identity mismatch')
        source_mount = mountid(source_fd)
        source_entries = [line.split(' - ', 1)[0].split(' ') for line in read_at(self_fd, 'mountinfo').splitlines() if line.split(' ', 1)[0] == source_mount]
        require(len(source_entries) == 1 and private(source_entries), 'source mount propagation is not private')
        emit('identity', target=target)
        command('create')
        revalidate(source=True)
        require(not mounts_at(), 'destination already mounted')
        os.mkdir(name, 0o700, dir_fd=run_fd)
        directory_fd = save(walk(root_fd, ['run', name]))
        created = ident(directory_fd)
        require(os.listdir(directory_fd) == [], 'destination not empty')
        emit('directory', identity=created)
        command('clone')
        revalidate(source=True)
        require(ident_at(run_fd, name, False) == created and not mounts_at(), 'destination changed')
        ctypes.set_errno(0)
        tree_fd = save(checked('open_tree', libc.open_tree(source_fd, b'', OPEN_TREE_FLAGS)))
        require(ident(tree_fd) == source_identity, 'clone source mismatch')
        mount_id = mountid(tree_fd)
        emit('prepared', mountId=mount_id)
        command('attach')
        revalidate(source=True)
        require(ident_at(run_fd, name, False) == created and not mounts_at(), 'destination changed before attach')
        enter_target()
        revalidate(source=True)
        ctypes.set_errno(0)
        checked('move_mount', libc.move_mount(tree_fd, b'', directory_fd, b'', MOVE_FLAGS))
        attached = True
        mounted_fd = save(walk(root_fd, ['run', name]))
        entries = mounts_at()
        require(len(entries) == 1 and entries[0][0] == mount_id and private(entries), 'attached mount id mismatch')
        require(mountid(mounted_fd) == mount_id and ident(mounted_fd) == source_identity, 'attached source mismatch')
        emit('attached')
        command('finish')
        emit('closed')
except Exception as error:
    if config and config.get('operation') == 'prepare' and created is not None:
        try:
            cleanup(created, mount_id if attached else None, source_identity)
        except Exception:
            pass
    emit('error', error=type(error).__name__, errno=getattr(error, 'errno', None))
    sys.exit(1)
finally:
    for descriptor in reversed(fds):
        try:
            os.close(descriptor)
        except OSError:
            pass
