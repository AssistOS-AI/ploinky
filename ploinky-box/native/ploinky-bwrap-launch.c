#define _GNU_SOURCE

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/mman.h>
#include <sys/syscall.h>
#endif

#ifndef PLOINKY_SOURCE_SHA
#error "PLOINKY_SOURCE_SHA must be the approved 40-character lowercase source commit"
#endif

#ifndef PLOINKY_BWRAP_PATH
#define PLOINKY_BWRAP_PATH "/usr/bin/bwrap"
#endif

#ifndef PLOINKY_WORKSPACE_ROOT
#define PLOINKY_WORKSPACE_ROOT "/workspace"
#endif

#ifndef O_PATH
#define O_PATH 010000000
#endif

#ifndef RESOLVE_NO_MAGICLINKS
#define RESOLVE_NO_MAGICLINKS 0x02
#endif
#ifndef RESOLVE_NO_SYMLINKS
#define RESOLVE_NO_SYMLINKS 0x04
#endif
#ifndef RESOLVE_BENEATH
#define RESOLVE_BENEATH 0x08
#endif

/*
 * ploinky-bwrap-launch wire protocol, version 2
 *
 * Normal launch has no command-line options. The complete non-secret launch
 * description is read from inherited fd 3. Introspection is limited to the
 * exact --version and --capabilities commands.
 *
 * Header (16 bytes):
 *   0..7   ASCII "PLBWLP02"
 *   8..11  big-endian record count
 *   12..15 zero
 *
 * Each record has an 8-byte header followed by its payload:
 *   byte 0       type
 *   byte 1       flags (zero)
 *   bytes 2..3   reserved (zero)
 *   bytes 4..7   big-endian payload length
 *
 * Record types, which remain in exact bwrap argument order:
 *   1 ARG        payload is one exact, non-NUL bwrap argument
 *   2 WORKSPACE  one-byte access: 1=RO, 2=RW; source/target are fixed
 *                to PLOINKY_WORKSPACE_ROOT and /workspace
 *   3 WORKDIR    existing protected-policy-checked workspace-relative dir;
 *                emitted RW at the identical /workspace/<relative> target
 *   4 HOME       byte source kind followed by its typed payload:
 *                1=sandbox-workspace-v2 plus one exact safe <home-key>
 *                  ending .sandbox-v2; helper derives .data/<home-key>
 *                2=container-native with no trailing payload; helper derives
 *                  fixed /root beneath its retained filesystem root fd
 *                Both are emitted RW at /home/agent. No caller path is used,
 *                and both dirs require euid ownership and exact mode 0700.
 *                Source kind 1 additionally openat2-pins a regular euid-owned
 *                mode-0600, single-link, <=4096-byte .ploinky-home-abi.json
 *                and requires exact canonical ploinky-home-v2 schema-2 JSON
 *                for its home key before exec.
 *   5 RO_PATH    byte source type (1=directory, 2=regular file), u16 source
 *                length, u16 target length, then absolute source and target
 *   6 DIR        one normalized absolute directory target
 *   7 TMPFS      one exact approved target: /tmp, /tmp/cache, /run,
 *                /workspace, /workspace/.ploinky, or /workspace/.data
 *   8 PROC       empty payload; fixed target /proc
 *   9 DEV        empty payload; fixed target /dev
 *  10 SYMLINK    one-byte fixed system mapping: 1=usr/bin->/bin,
 *                2=usr/sbin->/sbin, 3=usr/lib->/lib, 4=usr/lib64->/lib64
 *  11 PREEXEC_BARRIER two big-endian u32 inherited fds: ready-write then
 *                release-read. Helper writes 'R', closes ready, requires one
 *                'G', closes release, and revalidates every retained HOME
 *                (including the current marker entry) before exec.
 *
 * All mount sources are opened only after the complete message, argv, mount
 * destinations, and duplicate checks have passed. Workspace-relative opens
 * use one retained workspace fd. Other absolute sources are opened beneath a
 * retained / fd. Linux openat2 always uses RESOLVE_BENEATH,
 * RESOLVE_NO_MAGICLINKS, and RESOLVE_NO_SYMLINKS. There is no path fallback.
 *
 * ARG records must contain a bwrap "--" separator. Mount records are rejected
 * after it, which makes provider arguments data for bwrap rather than helper
 * options. Every filesystem mutation is a typed record; all raw filesystem
 * mutation, path-bind, and fd-argument injection options are rejected.
 * Externally inherited --ro-bind-data remains restricted to the fixed 0400
 * generation credential. Typed RO_DATA_PATH records are opened and pinned by
 * this helper itself, copied into a sealed anonymous memfd, and mounted with
 * --ro-bind-data. The sandbox receives exact fd-derived bytes on a real
 * read-only mount; bwrap never resolves a host source pathname for the copy.
 */

enum {
    DESCRIPTOR_FD = 3,
    MAX_DESCRIPTOR_BYTES = 256 * 1024,
    MAX_RECORDS = 1024,
    MAX_MOUNTS = 96,
    MAX_ARGS = 768,
    MAX_ARGUMENT_BYTES = 16 * 1024,
    MAX_PATH_BYTES = 4096,
    MAX_PRESERVED_FDS = 16,
    MAX_RO_DATA_FILE_BYTES = 4 * 1024 * 1024,
    MAX_HOME_KEY_BYTES = 255,
    MAX_HOME_MARKER_BYTES = 4096,
};

enum record_type {
    RECORD_ARG = 1,
    RECORD_WORKSPACE = 2,
    RECORD_WORKDIR = 3,
    RECORD_HOME = 4,
    RECORD_RO_PATH = 5,
    RECORD_DIR = 6,
    RECORD_TMPFS = 7,
    RECORD_PROC = 8,
    RECORD_DEV = 9,
    RECORD_SYMLINK = 10,
    RECORD_PREEXEC_BARRIER = 11,
    RECORD_RO_DATA_PATH = 12,
};

enum mount_kind {
    MOUNT_WORKSPACE,
    MOUNT_WORKDIR,
    MOUNT_HOME,
    MOUNT_RO_PATH,
    MOUNT_RO_DATA_PATH,
    MOUNT_DIR,
    MOUNT_TMPFS,
    MOUNT_PROC,
    MOUNT_DEV,
    MOUNT_SYMLINK,
};

enum source_type {
    SOURCE_DIRECTORY = 1,
    SOURCE_REGULAR = 2,
};

enum home_source_kind {
    HOME_SOURCE_SANDBOX_WORKSPACE_V2 = 1,
    HOME_SOURCE_CONTAINER_NATIVE = 2,
};

enum exit_status {
    EXIT_PROTOCOL_INVALID = 64,
    EXIT_PROTOCOL_TOO_LARGE = 65,
    EXIT_SOURCE_SHA_INVALID = 66,
    EXIT_PRIVILEGE_INVALID = 67,
    EXIT_PATHFD_UNAVAILABLE = 70,
    EXIT_WORKDIR_ROOT_FORBIDDEN = 71,
    EXIT_WORKDIR_INVALID = 72,
    EXIT_PATH_INVALID = 73,
    EXIT_BWRAP_UNAVAILABLE = 74,
    EXIT_BWRAP_EXEC_FAILED = 75,
    EXIT_HOME_STATE_INCOMPATIBLE = 76,
};

struct open_how_compat {
    uint64_t flags;
    uint64_t mode;
    uint64_t resolve;
};

struct record {
    uint8_t type;
    const unsigned char *payload;
    uint32_t length;
    size_t mount_index;
};

struct mount {
    enum mount_kind kind;
    enum source_type source_type;
    enum home_source_kind home_source_kind;
    bool writable;
    const unsigned char *source;
    size_t source_length;
    char *target;
    int fd;
    char fd_string[32];
};

struct launch {
    unsigned char *bytes;
    size_t bytes_length;
    struct record records[MAX_RECORDS];
    size_t record_count;
    struct mount mounts[MAX_MOUNTS];
    size_t mount_count;
    char *args[MAX_ARGS];
    size_t arg_count;
    int preserved_fds[MAX_PRESERVED_FDS];
    size_t preserved_fd_count;
    bool has_credential_fd;
    int credential_fd;
    bool has_workdir;
    bool has_preexec_barrier;
    int barrier_ready_fd;
    int barrier_release_fd;
};

static _Noreturn void fail(int status, const char *code, const char *format, ...)
{
    va_list args;

    fprintf(stderr, "%s: ", code);
    va_start(args, format);
    vfprintf(stderr, format, args);
    va_end(args);
    fputc('\n', stderr);
    exit(status);
}

static uint16_t read_u16_be(const unsigned char *bytes)
{
    return (uint16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);
}

static uint32_t read_u32_be(const unsigned char *bytes)
{
    return ((uint32_t)bytes[0] << 24) |
           ((uint32_t)bytes[1] << 16) |
           ((uint32_t)bytes[2] << 8) |
           (uint32_t)bytes[3];
}

static bool has_nul(const unsigned char *bytes, size_t length)
{
    return memchr(bytes, '\0', length) != NULL;
}

static bool source_sha_is_valid(void)
{
    static const char sha[] = PLOINKY_SOURCE_SHA;
    size_t i;

    if (sizeof(sha) != 41) {
        return false;
    }
    for (i = 0; i < 40; i++) {
        if (!((sha[i] >= '0' && sha[i] <= '9') ||
              (sha[i] >= 'a' && sha[i] <= 'f'))) {
            return false;
        }
    }
    return sha[40] == '\0';
}

static void require_source_sha(void)
{
    if (!source_sha_is_valid()) {
        fail(EXIT_SOURCE_SHA_INVALID, "PLOINKY_HELPER_SOURCE_SHA_INVALID",
             "compiled source SHA is not 40 lowercase hexadecimal characters");
    }
}

static unsigned char *read_descriptor(size_t *length_out)
{
    unsigned char *buffer;
    size_t used = 0;

    buffer = malloc(MAX_DESCRIPTOR_BYTES + 1);
    if (buffer == NULL) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "cannot allocate descriptor buffer");
    }

    for (;;) {
        ssize_t count = read(DESCRIPTOR_FD, buffer + used,
                             MAX_DESCRIPTOR_BYTES + 1 - used);
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            free(buffer);
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "cannot read launch descriptor fd");
        }
        if (count == 0) {
            break;
        }
        used += (size_t)count;
        if (used > MAX_DESCRIPTOR_BYTES) {
            free(buffer);
            fail(EXIT_PROTOCOL_TOO_LARGE, "PLOINKY_BWRAP_PROTOCOL_TOO_LARGE",
                 "launch descriptor exceeds %d bytes", MAX_DESCRIPTOR_BYTES);
        }
    }
    if (close(DESCRIPTOR_FD) != 0) {
        free(buffer);
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "cannot close launch descriptor fd");
    }

    *length_out = used;
    return buffer;
}

static bool is_clean_absolute_path(const unsigned char *bytes, size_t length)
{
    size_t component_start;
    size_t i;

    if (length < 2 || length >= MAX_PATH_BYTES || bytes[0] != '/' ||
        bytes[length - 1] == '/' || has_nul(bytes, length)) {
        return false;
    }
    component_start = 1;
    for (i = 1; i <= length; i++) {
        if (i == length || bytes[i] == '/') {
            size_t component_length = i - component_start;
            if (component_length == 0 ||
                (component_length == 1 && bytes[component_start] == '.') ||
                (component_length == 2 && bytes[component_start] == '.' &&
                 bytes[component_start + 1] == '.')) {
                return false;
            }
            component_start = i + 1;
        }
    }
    return true;
}

static bool component_equals(const unsigned char *bytes, size_t length,
                             size_t component_index, const char *expected)
{
    size_t start = 0;
    size_t current = 0;
    size_t i;
    size_t expected_length = strlen(expected);

    for (i = 0; i <= length; i++) {
        if (i == length || bytes[i] == '/') {
            if (current == component_index) {
                return i - start == expected_length &&
                       memcmp(bytes + start, expected, expected_length) == 0;
            }
            current++;
            start = i + 1;
        }
    }
    return false;
}

static size_t relative_component_count(const unsigned char *bytes, size_t length)
{
    size_t count = 1;
    size_t i;

    for (i = 0; i < length; i++) {
        if (bytes[i] == '/') {
            count++;
        }
    }
    return count;
}

static bool is_clean_relative_path(const unsigned char *bytes, size_t length)
{
    size_t component_start = 0;
    size_t i;

    if (length == 0 || length >= MAX_PATH_BYTES || bytes[0] == '/' ||
        bytes[length - 1] == '/' || has_nul(bytes, length)) {
        return false;
    }
    for (i = 0; i <= length; i++) {
        if (i == length || bytes[i] == '/') {
            size_t component_length = i - component_start;
            if (component_length == 0 ||
                (component_length == 1 && bytes[component_start] == '.') ||
                (component_length == 2 && bytes[component_start] == '.' &&
                 bytes[component_start + 1] == '.')) {
                return false;
            }
            component_start = i + 1;
        }
    }
    return true;
}

static bool is_exact_workspace_root_text(const unsigned char *bytes, size_t length)
{
    static const char absolute_root[] = "/workspace";

    return (length == 1 && bytes[0] == '.') ||
           (length == sizeof(absolute_root) - 1 &&
            memcmp(bytes, absolute_root, sizeof(absolute_root) - 1) == 0);
}

static void validate_workdir(const unsigned char *bytes, size_t length)
{
    size_t components;

    if (length == 0 || is_exact_workspace_root_text(bytes, length)) {
        fail(EXIT_WORKDIR_ROOT_FORBIDDEN, "PLOINKY_WORKDIR_ROOT_FORBIDDEN",
             "the workspace root cannot be selected writable");
    }
    if (!is_clean_relative_path(bytes, length)) {
        fail(EXIT_WORKDIR_INVALID, "PLOINKY_WORKDIR_INVALID",
             "workdir must be a clean workspace-relative path");
    }

    components = relative_component_count(bytes, length);
    if (component_equals(bytes, length, 0, ".data")) {
        fail(EXIT_WORKDIR_INVALID, "PLOINKY_WORKDIR_INVALID",
             "the protected .data hierarchy cannot be selected");
    }
    if (component_equals(bytes, length, 0, ".ploinky")) {
        if (components < 3 ||
            !component_equals(bytes, length, 1, "repos")) {
            fail(EXIT_WORKDIR_INVALID, "PLOINKY_WORKDIR_INVALID",
                 "only an exact repository below .ploinky/repos may be selected");
        }
    }
}

static bool home_key_has_sandbox_suffix(const unsigned char *bytes, size_t length)
{
    static const char suffix[] = ".sandbox-v2";

    return length > sizeof(suffix) - 1 &&
           memcmp(bytes + length - (sizeof(suffix) - 1), suffix,
                  sizeof(suffix) - 1) == 0;
}

static enum home_source_kind validate_home(
    const unsigned char *bytes, size_t length,
    const unsigned char **home_key, size_t *home_key_length)
{
    enum home_source_kind kind;
    size_t i;

    if (length == 0) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "HOME source kind is missing");
    }
    kind = (enum home_source_kind)bytes[0];
    if (kind == HOME_SOURCE_CONTAINER_NATIVE) {
        if (length != 1) {
            fail(EXIT_HOME_STATE_INCOMPATIBLE,
                 "PLOINKY_HOME_STATE_INCOMPATIBLE",
                 "container-native HOME has an unexpected caller payload");
        }
        *home_key = NULL;
        *home_key_length = 0;
        return kind;
    }
    if (kind != HOME_SOURCE_SANDBOX_WORKSPACE_V2 || length <= 1 ||
        length - 1 > MAX_HOME_KEY_BYTES ||
        !home_key_has_sandbox_suffix(bytes + 1, length - 1)) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "sandbox HOME requires one safe homeKey ending .sandbox-v2");
    }
    for (i = 1; i < length; i++) {
        unsigned char c = bytes[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) {
            fail(EXIT_HOME_STATE_INCOMPATIBLE,
                 "PLOINKY_HOME_STATE_INCOMPATIBLE",
                 "sandbox HOME key contains unsupported characters");
        }
    }
    *home_key = bytes + 1;
    *home_key_length = length - 1;
    return kind;
}

static char *copy_string(const unsigned char *bytes, size_t length,
                         const char *error_code)
{
    char *value;

    if (length == 0 || has_nul(bytes, length)) {
        fail(EXIT_PROTOCOL_INVALID, error_code, "string field is empty or contains NUL");
    }
    value = malloc(length + 1);
    if (value == NULL) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "cannot allocate launch field");
    }
    memcpy(value, bytes, length);
    value[length] = '\0';
    return value;
}

static bool path_has_prefix(const char *path, const char *prefix)
{
    size_t prefix_length = strlen(prefix);

    return strcmp(path, prefix) == 0 ||
           (strncmp(path, prefix, prefix_length) == 0 &&
            path[prefix_length] == '/');
}

static void validate_mount_target(const unsigned char *bytes, size_t length)
{
    char *target;

    if (!is_clean_absolute_path(bytes, length)) {
        fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
             "mount destination must be a normalized non-root absolute path");
    }
    target = copy_string(bytes, length, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
    if (path_has_prefix(target, "/proc") || path_has_prefix(target, "/dev") ||
        path_has_prefix(target, "/workspace") ||
        path_has_prefix(target, "/run/ploinky-agent") ||
        strcmp(target, "/home/agent") == 0) {
        free(target);
        fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
             "mount destination requires a dedicated policy record");
    }
    free(target);
}

static void validate_ro_data_path(const unsigned char *source,
                                  size_t source_length,
                                  const unsigned char *target,
                                  size_t target_length)
{
    static const struct {
        const char *source;
        const char *target;
    } approved[] = {
        {"/etc/resolv.conf", "/etc/resolv.conf"},
        {"/etc/hosts", "/etc/hosts"},
        {"/etc/passwd", "/etc/passwd"},
        {"/etc/group", "/etc/group"},
        {"/etc/authselect/nsswitch.conf", "/etc/nsswitch.conf"},
        {"/etc/ld.so.cache", "/etc/ld.so.cache"},
    };
    size_t i;

    if (!is_clean_absolute_path(source, source_length) ||
        !is_clean_absolute_path(target, target_length)) {
        fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
             "read-only data path must use normalized absolute paths");
    }
    for (i = 0; i < sizeof(approved) / sizeof(approved[0]); i++) {
        if (strlen(approved[i].source) == source_length &&
            memcmp(approved[i].source, source, source_length) == 0 &&
            strlen(approved[i].target) == target_length &&
            memcmp(approved[i].target, target, target_length) == 0) {
            return;
        }
    }
    fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
         "read-only data path is not an exact fixed system mapping");
}

static bool target_seen(const struct launch *launch, const char *target,
                        int expected_kind)
{
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        if (launch->mounts[i].target != NULL &&
            strcmp(launch->mounts[i].target, target) == 0 &&
            (expected_kind < 0 || (int)launch->mounts[i].kind == expected_kind)) {
            return true;
        }
    }
    return false;
}

static bool target_seen_before(const struct launch *launch, const char *target,
                               int expected_kind, size_t mount_limit)
{
    size_t i;

    if (mount_limit > launch->mount_count) {
        mount_limit = launch->mount_count;
    }
    for (i = 0; i < mount_limit; i++) {
        if (launch->mounts[i].target != NULL &&
            strcmp(launch->mounts[i].target, target) == 0 &&
            (expected_kind < 0 || (int)launch->mounts[i].kind == expected_kind)) {
            return true;
        }
    }
    return false;
}

static void reject_hiding_prior_target(const struct launch *launch,
                                       const char *new_ancestor)
{
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        const char *prior = launch->mounts[i].target;
        size_t ancestor_length = strlen(new_ancestor);
        size_t prior_length = prior == NULL ? 0 : strlen(prior);
        if (prior != NULL && prior_length > ancestor_length &&
            strncmp(prior, new_ancestor, ancestor_length) == 0 &&
            prior[ancestor_length] == '/') {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                 "later mount at %s would hide prior target %s",
                 new_ancestor, prior);
        }
    }
}

static void require_workspace_parent_before_child(const struct launch *launch,
                                                  const char *target)
{
    if (path_has_prefix(target, "/workspace") &&
        strcmp(target, "/workspace") != 0 &&
        !target_seen(launch, "/workspace", MOUNT_WORKSPACE) &&
        !target_seen(launch, "/workspace", MOUNT_TMPFS)) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
             "workspace root must precede descendant target %s", target);
    }
}

static void validate_dir_target(const unsigned char *bytes, size_t length)
{
    char *target;

    if (!is_clean_absolute_path(bytes, length)) {
        fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
             "directory target must be a normalized non-root absolute path");
    }
    target = copy_string(bytes, length, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
    if (!(strcmp(target, "/opt") == 0 ||
          strcmp(target, "/home") == 0 ||
          strcmp(target, "/workspace/readiness") == 0 ||
          strcmp(target, "/run/ploinky-agent") == 0 ||
          path_has_prefix(target, "/workspace/.ploinky/repos"))) {
        free(target);
        fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
             "directory target is not in the fixed v1 policy");
    }
    free(target);
}

static bool approved_tmpfs_target(const unsigned char *bytes, size_t length)
{
    static const char *const targets[] = {
        "/tmp",
        "/tmp/cache",
        "/run",
        "/workspace",
        "/workspace/.ploinky",
        "/workspace/.data",
    };
    size_t i;

    for (i = 0; i < sizeof(targets) / sizeof(targets[0]); i++) {
        if (strlen(targets[i]) == length &&
            memcmp(bytes, targets[i], length) == 0) {
            return true;
        }
    }
    return false;
}

static void require_managed_repo_parent(const struct launch *launch,
                                        const char *target, bool target_is_workdir)
{
    static const char repos_root[] = "/workspace/.ploinky/repos";
    size_t root_length = sizeof(repos_root) - 1;
    size_t target_length = strlen(target);
    size_t i;

    if (!path_has_prefix(target, repos_root)) {
        return;
    }
    if (!target_seen(launch, "/workspace/.ploinky", MOUNT_TMPFS)) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
             "managed repository reconstruction requires the .ploinky mask first");
    }
    if (strcmp(target, repos_root) == 0) {
        return;
    }
    if (!target_seen(launch, repos_root, MOUNT_DIR)) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
             "managed repository reconstruction requires %s first", repos_root);
    }
    for (i = root_length + 1; i < target_length; i++) {
        if (target[i] == '/') {
            char *parent = strndup(target, i);
            bool seen;
            if (parent == NULL) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "cannot allocate managed repository parent");
            }
            seen = target_seen(launch, parent, MOUNT_DIR);
            if (!seen) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "managed repository parent %s must be created first", parent);
            }
            free(parent);
        }
    }
    if (!target_is_workdir) {
        const char *last_slash = strrchr(target, '/');
        if (last_slash != NULL && (size_t)(last_slash - target) > root_length) {
            char *parent = strndup(target, (size_t)(last_slash - target));
            bool seen;
            if (parent == NULL) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "cannot allocate managed repository parent");
            }
            seen = target_seen(launch, parent, MOUNT_DIR);
            if (!seen) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "managed repository parent %s must be created first", parent);
            }
            free(parent);
        }
    }
}

static void fixed_symlink_mapping(unsigned char mapping,
                                  const char **source, const char **target)
{
    static const char *const sources[] = {
        NULL, "usr/bin", "usr/sbin", "usr/lib", "usr/lib64",
    };
    static const char *const targets[] = {
        NULL, "/bin", "/sbin", "/lib", "/lib64",
    };

    if (mapping == 0 || mapping >= sizeof(sources) / sizeof(sources[0])) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "unsupported fixed system symlink mapping");
    }
    *source = sources[mapping];
    *target = targets[mapping];
}

static void reject_duplicate_target(const struct launch *launch, const char *target)
{
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        if (launch->mounts[i].target != NULL &&
            strcmp(launch->mounts[i].target, target) == 0) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_DUPLICATE_MOUNT",
                 "duplicate mount destination %s", target);
        }
    }
}

static struct mount *new_mount(struct launch *launch)
{
    struct mount *mount;

    if (launch->mount_count >= MAX_MOUNTS) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "too many mount records");
    }
    mount = &launch->mounts[launch->mount_count++];
    memset(mount, 0, sizeof(*mount));
    mount->fd = -1;
    return mount;
}

static char *workdir_target(const unsigned char *source, size_t source_length)
{
    static const char prefix[] = "/workspace/";
    char *target = malloc(sizeof(prefix) - 1 + source_length + 1);

    if (target == NULL) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "cannot allocate workdir target");
    }
    memcpy(target, prefix, sizeof(prefix) - 1);
    memcpy(target + sizeof(prefix) - 1, source, source_length);
    target[sizeof(prefix) - 1 + source_length] = '\0';
    return target;
}

static bool is_forbidden_bwrap_option(const char *arg)
{
    static const char *const forbidden[] = {
        "--bind", "--bind-try", "--ro-bind", "--ro-bind-try",
        "--dev-bind", "--dev-bind-try", "--bind-fd", "--ro-bind-fd",
        "--bind-data", "--ro-bind-data", "--file", "--args", "--seccomp",
        "--add-seccomp-fd", "--block-fd", "--userns", "--userns2",
        "--userns-block-fd", "--pidns", "--sync-fd", "--info-fd",
        "--json-status-fd", "--overlay-src", "--overlay", "--ro-overlay",
        "--tmp-overlay", "--lock-file", "--dir", "--tmpfs", "--proc",
        "--dev", "--mqueue", "--symlink", "--chmod", "--remount-ro",
        "--size", "--file-label", "--exec-label", "--cap-add", "--cap-drop",
        "--keep-fd", "--unshare-user-try", "--unshare-cgroup-try",
    };
    size_t i;

    for (i = 0; i < sizeof(forbidden) / sizeof(forbidden[0]); i++) {
        size_t option_length = strlen(forbidden[i]);
        if (strcmp(arg, forbidden[i]) == 0 ||
            (strncmp(arg, forbidden[i], option_length) == 0 &&
             arg[option_length] == '=')) {
            return true;
        }
    }
    return false;
}

static int parse_fd_number(const char *text)
{
    char *end = NULL;
    long value;

    errno = 0;
    value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' ||
        value <= DESCRIPTOR_FD || value > INT_MAX) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "invalid inherited data fd");
    }
    return (int)value;
}

static bool unix_socket_address_is_unnamed(int fd, bool peer)
{
    struct sockaddr_un address;
    socklen_t length = sizeof(address);
    int result;

    memset(&address, 0, sizeof(address));
    result = peer
        ? getpeername(fd, (struct sockaddr *)&address, &length)
        : getsockname(fd, (struct sockaddr *)&address, &length);
    if (result != 0 || address.sun_family != AF_UNIX ||
        length < offsetof(struct sockaddr_un, sun_path)) {
        return false;
    }
    if (length > offsetof(struct sockaddr_un, sun_path)) {
        size_t path_bytes = (size_t)length - offsetof(struct sockaddr_un, sun_path);
        size_t i;
        if (path_bytes > sizeof(address.sun_path)) {
            path_bytes = sizeof(address.sun_path);
        }
        for (i = 0; i < path_bytes; i++) {
            if (address.sun_path[i] != '\0') {
                return false;
            }
        }
    }
    return true;
}

static bool fd_is_anonymous_pipe(int fd)
{
    char proc_path[64];
    char target[96];
    ssize_t length;

    snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", fd);
    length = readlink(proc_path, target, sizeof(target) - 1);
    if (length <= 7 || (size_t)length >= sizeof(target)) {
        return false;
    }
    target[length] = '\0';
    return strncmp(target, "pipe:[", sizeof("pipe:[") - 1) == 0 &&
           target[length - 1] == ']';
}

static void require_anonymous_ipc_fd(int fd, const char *purpose)
{
    struct stat status;
    int socket_type = 0;
    socklen_t socket_type_length = sizeof(socket_type);

    if (fcntl(fd, F_GETFD) < 0 || fstat(fd, &status) != 0) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "%s must be an open inherited anonymous IPC fd", purpose);
    }
    if (S_ISFIFO(status.st_mode) && fd_is_anonymous_pipe(fd)) {
        return;
    }
    if (S_ISSOCK(status.st_mode) &&
        getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type,
                   &socket_type_length) == 0 &&
        socket_type == SOCK_STREAM &&
        unix_socket_address_is_unnamed(fd, false) &&
        unix_socket_address_is_unnamed(fd, true)) {
        return;
    }
    fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
         "%s must be a FIFO or connected unnamed AF_UNIX SOCK_STREAM socketpair",
         purpose);
}

static void preserve_fd(struct launch *launch, int fd)
{
    size_t i;

    for (i = 0; i < launch->preserved_fd_count; i++) {
        if (launch->preserved_fds[i] == fd) {
            return;
        }
    }
    if (launch->has_preexec_barrier &&
        (fd == launch->barrier_ready_fd || fd == launch->barrier_release_fd)) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "credential data fd aliases a pre-exec barrier fd");
    }
    if (launch->preserved_fd_count >= MAX_PRESERVED_FDS) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "too many inherited data fds");
    }
    require_anonymous_ipc_fd(fd, "credential data fd");
    launch->preserved_fds[launch->preserved_fd_count++] = fd;
    launch->has_credential_fd = true;
    launch->credential_fd = fd;
}

static void validate_argument_policy(struct launch *launch)
{
    static const char credential_target[] =
        "/run/ploinky-agent/credential.json";
    bool separator = false;
    bool command_seen = false;
    bool credential_data_seen = false;
    enum {
        DATA_IDLE,
        DATA_EXPECT_PERMS_VALUE,
        DATA_EXPECT_OPERATION,
        DATA_EXPECT_FD,
        DATA_EXPECT_TARGET,
    } data_state = DATA_IDLE;
    size_t mounts_seen = 0;
    size_t i;

    for (i = 0; i < launch->record_count; i++) {
        struct record *record = &launch->records[i];
        char *arg;

        if (record->type != RECORD_ARG) {
            if (separator) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "mount records are forbidden after the bwrap separator");
            }
            if (data_state != DATA_IDLE) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "mount record interrupts --ro-bind-data arguments");
            }
            if (record->type != RECORD_PREEXEC_BARRIER) {
                mounts_seen++;
            }
            continue;
        }

        arg = launch->args[record->mount_index];
        if (!separator && strcmp(arg, "--") == 0) {
            if (data_state != DATA_IDLE) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "incomplete --ro-bind-data operation");
            }
            separator = true;
            continue;
        }
        if (separator) {
            command_seen = true;
            continue;
        }
        if (data_state == DATA_EXPECT_PERMS_VALUE) {
            if (strcmp(arg, "0400") != 0) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "credential data mount requires exact --perms 0400");
            }
            data_state = DATA_EXPECT_OPERATION;
            continue;
        }
        if (data_state == DATA_EXPECT_OPERATION) {
            if (strcmp(arg, "--ro-bind-data") != 0 || credential_data_seen) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "--perms 0400 must apply to one credential data mount");
            }
            data_state = DATA_EXPECT_FD;
            continue;
        }
        if (data_state == DATA_EXPECT_FD) {
            preserve_fd(launch, parse_fd_number(arg));
            data_state = DATA_EXPECT_TARGET;
            continue;
        }
        if (data_state == DATA_EXPECT_TARGET) {
            if (strcmp(arg, credential_target) != 0) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "credential data mount has an unsupported destination");
            }
            if (target_seen(launch, credential_target, -1) ||
                !target_seen_before(launch, "/run/ploinky-agent", MOUNT_DIR,
                                    mounts_seen)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "credential target requires its typed private directory and no collision");
            }
            credential_data_seen = true;
            data_state = DATA_IDLE;
            continue;
        }
        if (strcmp(arg, "--perms") == 0) {
            data_state = DATA_EXPECT_PERMS_VALUE;
            continue;
        }
        if (strcmp(arg, "--ro-bind-data") == 0) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "credential data mount requires exact --perms 0400");
        }
        if (is_forbidden_bwrap_option(arg)) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_OPTION_FORBIDDEN",
                 "raw filesystem/fd bwrap option %s is forbidden", arg);
        }
        if (strncmp(arg, "--perms=", sizeof("--perms=") - 1) == 0) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "credential data mount requires separate --perms 0400 arguments");
        }
    }

    if (data_state != DATA_IDLE || !separator || !command_seen) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "launch must contain complete bwrap options, --, and a command");
    }
}

static void parse_descriptor(struct launch *launch)
{
    static const unsigned char magic[] = "PLBWLP02";
    uint32_t declared_records;
    size_t offset;
    size_t i;

    if (launch->bytes_length < 16 ||
        memcmp(launch->bytes, magic, sizeof(magic) - 1) != 0 ||
        launch->bytes[12] != 0 || launch->bytes[13] != 0 ||
        launch->bytes[14] != 0 || launch->bytes[15] != 0) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "invalid versioned launch header");
    }
    declared_records = read_u32_be(launch->bytes + 8);
    if (declared_records == 0 || declared_records > MAX_RECORDS) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "invalid launch record count");
    }

    offset = 16;
    for (i = 0; i < declared_records; i++) {
        struct record *record;
        uint32_t payload_length;

        if (launch->bytes_length - offset < 8) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "truncated record header");
        }
        record = &launch->records[launch->record_count++];
        record->type = launch->bytes[offset];
        if (launch->bytes[offset + 1] != 0 || launch->bytes[offset + 2] != 0 ||
            launch->bytes[offset + 3] != 0) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "record flags and reserved bytes must be zero");
        }
        payload_length = read_u32_be(launch->bytes + offset + 4);
        offset += 8;
        if (payload_length > launch->bytes_length - offset) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "truncated record payload");
        }
        record->payload = launch->bytes + offset;
        record->length = payload_length;
        offset += payload_length;

        if (record->type == RECORD_ARG) {
            if (payload_length == 0 || payload_length > MAX_ARGUMENT_BYTES ||
                has_nul(record->payload, payload_length) ||
                launch->arg_count >= MAX_ARGS) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid bwrap argument record");
            }
            record->mount_index = launch->arg_count;
            launch->args[launch->arg_count++] =
                copy_string(record->payload, payload_length,
                            "PLOINKY_BWRAP_PROTOCOL_INVALID");
            continue;
        }

        if (record->type == RECORD_PREEXEC_BARRIER) {
            uint32_t ready;
            uint32_t release;
            if (payload_length != 8 || launch->has_preexec_barrier) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid or duplicate pre-exec barrier record");
            }
            ready = read_u32_be(record->payload);
            release = read_u32_be(record->payload + 4);
            if (ready <= DESCRIPTOR_FD || release <= DESCRIPTOR_FD ||
                ready > INT_MAX || release > INT_MAX || ready == release ||
                fcntl((int)ready, F_GETFD) < 0 ||
                fcntl((int)release, F_GETFD) < 0) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "pre-exec barrier fds must be distinct open inherited fds above 3");
            }
            require_anonymous_ipc_fd((int)ready, "pre-exec ready fd");
            require_anonymous_ipc_fd((int)release, "pre-exec release fd");
            launch->has_preexec_barrier = true;
            launch->barrier_ready_fd = (int)ready;
            launch->barrier_release_fd = (int)release;
            continue;
        }

        record->mount_index = launch->mount_count;
        if (record->type == RECORD_WORKSPACE) {
            struct mount *mount;
            if (payload_length != 1 ||
                (record->payload[0] != 1 && record->payload[0] != 2)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid workspace mount record");
            }
            reject_duplicate_target(launch, "/workspace");
            reject_hiding_prior_target(launch, "/workspace");
            mount = new_mount(launch);
            mount->kind = MOUNT_WORKSPACE;
            mount->source_type = SOURCE_DIRECTORY;
            mount->writable = record->payload[0] == 2;
            mount->target = strdup("/workspace");
        } else if (record->type == RECORD_WORKDIR) {
            struct mount *mount;
            char *target;
            if (launch->has_workdir) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "launch description contains more than one WORKDIR");
            }
            validate_workdir(record->payload, payload_length);
            target = workdir_target(record->payload, payload_length);
            require_workspace_parent_before_child(launch, target);
            if (!target_seen(launch, "/workspace", MOUNT_WORKSPACE)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "WORKDIR requires the bound workspace root first");
            }
            require_managed_repo_parent(launch, target, true);
            reject_duplicate_target(launch, target);
            reject_hiding_prior_target(launch, target);
            mount = new_mount(launch);
            mount->kind = MOUNT_WORKDIR;
            mount->source_type = SOURCE_DIRECTORY;
            mount->writable = true;
            mount->source = record->payload;
            mount->source_length = payload_length;
            mount->target = target;
            launch->has_workdir = true;
        } else if (record->type == RECORD_HOME) {
            struct mount *mount;
            const unsigned char *home_key;
            size_t home_key_length;
            enum home_source_kind home_source_kind =
                validate_home(record->payload, payload_length,
                              &home_key, &home_key_length);
            reject_duplicate_target(launch, "/home/agent");
            reject_hiding_prior_target(launch, "/home/agent");
            mount = new_mount(launch);
            mount->kind = MOUNT_HOME;
            mount->source_type = SOURCE_DIRECTORY;
            mount->home_source_kind = home_source_kind;
            mount->writable = true;
            mount->source = home_key;
            mount->source_length = home_key_length;
            mount->target = strdup("/home/agent");
        } else if (record->type == RECORD_RO_PATH) {
            struct mount *mount;
            uint16_t source_length;
            uint16_t target_length;
            const unsigned char *source;
            const unsigned char *target;
            char *target_string;

            if (payload_length < 5 ||
                (record->payload[0] != SOURCE_DIRECTORY &&
                 record->payload[0] != SOURCE_REGULAR)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid read-only path mount record");
            }
            source_length = read_u16_be(record->payload + 1);
            target_length = read_u16_be(record->payload + 3);
            if ((size_t)source_length + (size_t)target_length + 5 != payload_length) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid read-only path mount lengths");
            }
            source = record->payload + 5;
            target = source + source_length;
            if (!is_clean_absolute_path(source, source_length)) {
                fail(EXIT_PATH_INVALID, "PLOINKY_PATH_INVALID",
                     "read-only mount source must be a normalized absolute path");
            }
            validate_mount_target(target, target_length);
            target_string = copy_string(target, target_length,
                                        "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
            if (path_has_prefix(target_string, "/home/agent") &&
                strcmp(target_string, "/home/agent") != 0 &&
                !target_seen(launch, "/home/agent", MOUNT_HOME)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "HOME must precede read-only executable overlays");
            }
            reject_duplicate_target(launch, target_string);
            reject_hiding_prior_target(launch, target_string);
            mount = new_mount(launch);
            mount->kind = MOUNT_RO_PATH;
            mount->source_type = (enum source_type)record->payload[0];
            mount->source = source;
            mount->source_length = source_length;
            mount->target = target_string;
        } else if (record->type == RECORD_RO_DATA_PATH) {
            struct mount *mount;
            uint16_t source_length;
            uint16_t target_length;
            const unsigned char *source;
            const unsigned char *target;
            char *target_string;

            if (payload_length < 4) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid read-only data path record");
            }
            source_length = read_u16_be(record->payload);
            target_length = read_u16_be(record->payload + 2);
            if ((size_t)source_length + (size_t)target_length + 4 != payload_length) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "invalid read-only data path lengths");
            }
            source = record->payload + 4;
            target = source + source_length;
            validate_ro_data_path(source, source_length, target, target_length);
            target_string = copy_string(target, target_length,
                                        "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
            reject_duplicate_target(launch, target_string);
            reject_hiding_prior_target(launch, target_string);
            mount = new_mount(launch);
            mount->kind = MOUNT_RO_DATA_PATH;
            mount->source_type = SOURCE_REGULAR;
            mount->source = source;
            mount->source_length = source_length;
            mount->target = target_string;
        } else if (record->type == RECORD_DIR) {
            struct mount *mount;
            char *target;
            validate_dir_target(record->payload, payload_length);
            target = copy_string(record->payload, payload_length,
                                 "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
            require_workspace_parent_before_child(launch, target);
            if (strcmp(target, "/workspace/readiness") == 0 &&
                !target_seen(launch, "/workspace", MOUNT_TMPFS)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "private readiness requires the /workspace tmpfs first");
            }
            if (path_has_prefix(target, "/run") && strcmp(target, "/run") != 0 &&
                !target_seen(launch, "/run", MOUNT_TMPFS)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "the /run tmpfs must precede directory target %s", target);
            }
            require_managed_repo_parent(launch, target, false);
            reject_duplicate_target(launch, target);
            reject_hiding_prior_target(launch, target);
            mount = new_mount(launch);
            mount->kind = MOUNT_DIR;
            mount->target = target;
        } else if (record->type == RECORD_TMPFS) {
            struct mount *mount;
            char *target;
            if (!approved_tmpfs_target(record->payload, payload_length)) {
                fail(EXIT_PATH_INVALID, "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED",
                     "tmpfs target is not in the fixed v1 allowlist");
            }
            target = copy_string(record->payload, payload_length,
                                 "PLOINKY_MOUNT_DESTINATION_UNSUPPORTED");
            require_workspace_parent_before_child(launch, target);
            if (strcmp(target, "/tmp/cache") == 0 &&
                !target_seen(launch, "/tmp", MOUNT_TMPFS)) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_MOUNT_ORDER_INVALID",
                     "the /tmp tmpfs must precede /tmp/cache");
            }
            reject_duplicate_target(launch, target);
            reject_hiding_prior_target(launch, target);
            mount = new_mount(launch);
            mount->kind = MOUNT_TMPFS;
            mount->target = target;
        } else if (record->type == RECORD_PROC || record->type == RECORD_DEV) {
            struct mount *mount;
            const char *target = record->type == RECORD_PROC ? "/proc" : "/dev";
            if (payload_length != 0) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "proc and dev records have empty payloads");
            }
            reject_duplicate_target(launch, target);
            reject_hiding_prior_target(launch, target);
            mount = new_mount(launch);
            mount->kind = record->type == RECORD_PROC ? MOUNT_PROC : MOUNT_DEV;
            mount->target = strdup(target);
        } else if (record->type == RECORD_SYMLINK) {
            struct mount *mount;
            const char *source;
            const char *target;
            if (payload_length != 1) {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "system symlink record requires one mapping byte");
            }
            fixed_symlink_mapping(record->payload[0], &source, &target);
            reject_duplicate_target(launch, target);
            reject_hiding_prior_target(launch, target);
            mount = new_mount(launch);
            mount->kind = MOUNT_SYMLINK;
            mount->source = (const unsigned char *)source;
            mount->source_length = strlen(source);
            mount->target = strdup(target);
        } else {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "unknown launch record type %u", record->type);
        }

        if (launch->mounts[record->mount_index].target == NULL) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                 "cannot allocate mount target");
        }
    }
    if (offset != launch->bytes_length) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "trailing launch descriptor bytes");
    }
    validate_argument_policy(launch);
}

#ifdef __linux__
static bool unavailable_openat2_errno(int error)
{
    return error == ENOSYS || error == EINVAL || error == E2BIG ||
           error == ENOTSUP || error == EOPNOTSUPP;
}
#endif

static int openat2_beneath(int root_fd, const char *relative, bool directory,
                           int policy_status, const char *policy_code)
{
#ifdef __linux__
    struct open_how_compat how;
    int fd;

    memset(&how, 0, sizeof(how));
    how.flags = O_PATH | O_CLOEXEC | (directory ? O_DIRECTORY : 0);
    how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS;
    fd = (int)syscall(SYS_openat2, root_fd, relative, &how, sizeof(how));
    if (fd >= 0) {
        return fd;
    }
    if (unavailable_openat2_errno(errno)) {
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "openat2 with required resolve flags is unavailable");
    }
    fail(policy_status, policy_code,
         "fd-pinned source resolution failed: %s", strerror(errno));
#else
    (void)root_fd;
    (void)relative;
    (void)directory;
    (void)policy_status;
    (void)policy_code;
    fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
         "Linux openat2 is required");
#endif
}

static int open_workspace_root(int policy_status, const char *policy_code)
{
    struct stat status;
    int fd = open(PLOINKY_WORKSPACE_ROOT,
                  O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);

    if (fd < 0) {
        fail(policy_status, policy_code,
             "cannot open exact workspace root: %s", strerror(errno));
    }
    if (fstat(fd, &status) != 0 || !S_ISDIR(status.st_mode) ||
        status.st_dev == 0 || status.st_uid != geteuid()) {
        close(fd);
        fail(policy_status, policy_code,
             "workspace root ownership, type, or device is invalid");
    }
    return fd;
}

static int open_filesystem_root(int policy_status, const char *policy_code)
{
    int fd = open("/", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
        fail(policy_status, policy_code,
             "cannot retain filesystem root fd");
    }
    return fd;
}

static void require_source_type(int fd, enum source_type source_type,
                                int policy_status, const char *policy_code)
{
    struct stat status;

    if (fstat(fd, &status) != 0) {
        fail(policy_status, policy_code, "cannot inspect retained source fd");
    }
    if ((source_type == SOURCE_DIRECTORY && !S_ISDIR(status.st_mode)) ||
        (source_type == SOURCE_REGULAR && !S_ISREG(status.st_mode))) {
        fail(policy_status, policy_code,
             "retained source has the wrong filesystem type");
    }
}

static char *copy_path_without_prefix(const unsigned char *bytes, size_t length,
                                      size_t prefix_length)
{
    return copy_string(bytes + prefix_length, length - prefix_length,
                       "PLOINKY_PATH_INVALID");
}

static bool mount_needs_fd(const struct mount *mount)
{
    return mount->kind == MOUNT_WORKSPACE || mount->kind == MOUNT_WORKDIR ||
           mount->kind == MOUNT_HOME || mount->kind == MOUNT_RO_PATH ||
           mount->kind == MOUNT_RO_DATA_PATH;
}

#ifdef __linux__
static int reopen_pinned_regular_readonly(int path_fd)
{
    char proc_path[64];
    struct stat pinned;
    struct stat readable;
    int fd;

    if (fstat(path_fd, &pinned) != 0 || !S_ISREG(pinned.st_mode)) {
        fail(EXIT_PATH_INVALID, "PLOINKY_PATH_INVALID",
             "cannot inspect pinned read-only data source");
    }
    if (snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", path_fd) < 0) {
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot address pinned read-only data fd");
    }
    fd = open(proc_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &readable) != 0 ||
        readable.st_dev != pinned.st_dev || readable.st_ino != pinned.st_ino ||
        !S_ISREG(readable.st_mode)) {
        if (fd >= 0) close(fd);
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot reopen the exact pinned read-only data source");
    }
    return fd;
}
#endif

static int reopen_pinned_home_marker_readonly(int path_fd)
{
    char proc_path[64];
    struct stat pinned;
    struct stat readable;
    int written;
    int fd;

    if (fstat(path_fd, &pinned) != 0 || !S_ISREG(pinned.st_mode)) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "cannot inspect the fd-pinned HOME ABI marker");
    }
    written = snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", path_fd);
    if (written < 0 || (size_t)written >= sizeof(proc_path)) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "cannot address the fd-pinned HOME ABI marker");
    }
    fd = open(proc_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &readable) != 0 ||
        readable.st_dev != pinned.st_dev || readable.st_ino != pinned.st_ino ||
        !S_ISREG(readable.st_mode)) {
        if (fd >= 0) close(fd);
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "cannot reopen the exact fd-pinned HOME ABI marker");
    }
    return fd;
}

static bool home_generation_first(unsigned char value)
{
    return (value >= 'a' && value <= 'z') ||
           (value >= 'A' && value <= 'Z') ||
           (value >= '0' && value <= '9');
}

static bool home_generation_character(unsigned char value)
{
    return home_generation_first(value) || value == ':' || value == '.' ||
           value == '_' || value == '/' || value == '-';
}

static void require_canonical_home_marker(const unsigned char *marker,
                                          size_t marker_length,
                                          const unsigned char *home_key,
                                          size_t home_key_length)
{
    static const char prefix[] =
        "{\"abi\":\"ploinky-home-v2\",\"createdByGeneration\":\"";
    static const char middle[] = "\",\"homeKey\":\"";
    static const char suffix[] = "\",\"schemaVersion\":2}\n";
    size_t offset = 0;
    size_t generation_start;
    size_t generation_length;

    if (marker_length < sizeof(prefix) - 1 ||
        memcmp(marker, prefix, sizeof(prefix) - 1) != 0) {
        goto incompatible;
    }
    offset = sizeof(prefix) - 1;
    generation_start = offset;
    while (offset < marker_length && marker[offset] != '"') {
        if (!home_generation_character(marker[offset])) {
            goto incompatible;
        }
        offset++;
    }
    generation_length = offset - generation_start;
    if (generation_length == 0 || generation_length > 255 ||
        !home_generation_first(marker[generation_start])) {
        goto incompatible;
    }
    if (marker_length - offset < sizeof(middle) - 1 ||
        memcmp(marker + offset, middle, sizeof(middle) - 1) != 0) {
        goto incompatible;
    }
    offset += sizeof(middle) - 1;
    if (marker_length - offset < home_key_length ||
        memcmp(marker + offset, home_key, home_key_length) != 0) {
        goto incompatible;
    }
    offset += home_key_length;
    if (marker_length - offset != sizeof(suffix) - 1 ||
        memcmp(marker + offset, suffix, sizeof(suffix) - 1) != 0) {
        goto incompatible;
    }
    return;

incompatible:
    fail(EXIT_HOME_STATE_INCOMPATIBLE,
         "PLOINKY_HOME_STATE_INCOMPATIBLE",
         "HOME ABI marker is not exact canonical ploinky-home-v2 schema 2 JSON");
}

static void validate_sandbox_home_marker(int home_fd,
                                         const unsigned char *home_key,
                                         size_t home_key_length)
{
    static const char marker_name[] = ".ploinky-home-abi.json";
    unsigned char bytes[MAX_HOME_MARKER_BYTES + 1];
    struct stat pinned;
    struct stat after;
    int marker_fd;
    int readable_fd;
    size_t used = 0;

    marker_fd = openat2_beneath(home_fd, marker_name, false,
                                EXIT_HOME_STATE_INCOMPATIBLE,
                                "PLOINKY_HOME_STATE_INCOMPATIBLE");
    if (fstat(marker_fd, &pinned) != 0 || !S_ISREG(pinned.st_mode) ||
        pinned.st_uid != geteuid() || (pinned.st_mode & 07777) != 0600 ||
        pinned.st_nlink != 1 || pinned.st_size <= 0 ||
        pinned.st_size > (off_t)MAX_HOME_MARKER_BYTES) {
        close(marker_fd);
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "HOME ABI marker type, owner, mode, link count, or size is invalid");
    }
    readable_fd = reopen_pinned_home_marker_readonly(marker_fd);
    for (;;) {
        ssize_t count = read(readable_fd, bytes + used, sizeof(bytes) - used);
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count < 0) {
            close(readable_fd);
            close(marker_fd);
            fail(EXIT_HOME_STATE_INCOMPATIBLE,
                 "PLOINKY_HOME_STATE_INCOMPATIBLE",
                 "cannot read the fd-pinned HOME ABI marker");
        }
        if (count == 0) {
            break;
        }
        used += (size_t)count;
        if (used > MAX_HOME_MARKER_BYTES) {
            close(readable_fd);
            close(marker_fd);
            fail(EXIT_HOME_STATE_INCOMPATIBLE,
                 "PLOINKY_HOME_STATE_INCOMPATIBLE",
                 "HOME ABI marker exceeds 4096 bytes");
        }
    }
    if (fstat(readable_fd, &after) != 0 ||
        after.st_dev != pinned.st_dev || after.st_ino != pinned.st_ino ||
        !S_ISREG(after.st_mode) || after.st_uid != geteuid() ||
        (after.st_mode & 07777) != 0600 || after.st_nlink != 1 ||
        after.st_size != pinned.st_size || used != (size_t)after.st_size) {
        close(readable_fd);
        close(marker_fd);
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "HOME ABI marker changed or became incompatible while pinned");
    }
    close(readable_fd);
    close(marker_fd);
    require_canonical_home_marker(bytes, used, home_key, home_key_length);
}

static char *sandbox_home_relative_path(const struct mount *mount)
{
    static const char prefix[] = ".data/";
    size_t prefix_length = sizeof(prefix) - 1;
    char *relative = malloc(prefix_length + mount->source_length + 1);

    if (relative == NULL) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "cannot allocate the derived sandbox HOME path");
    }
    memcpy(relative, prefix, prefix_length);
    memcpy(relative + prefix_length, mount->source, mount->source_length);
    relative[prefix_length + mount->source_length] = '\0';
    return relative;
}

static void validate_home_directory(const struct mount *mount)
{
    struct stat status;

    if (fstat(mount->fd, &status) != 0 || !S_ISDIR(status.st_mode) ||
        status.st_uid != geteuid() || (status.st_mode & 07777) != 0700) {
        fail(EXIT_HOME_STATE_INCOMPATIBLE,
             "PLOINKY_HOME_STATE_INCOMPATIBLE",
             "HOME directory type, owner, or exact mode 0700 is invalid");
    }
    if (mount->home_source_kind == HOME_SOURCE_SANDBOX_WORKSPACE_V2) {
        validate_sandbox_home_marker(mount->fd, mount->source,
                                     mount->source_length);
    }
}

static int snapshot_pinned_regular_readonly(int path_fd)
{
#ifdef __linux__
    unsigned char buffer[16384];
    const int required_seals = F_SEAL_SEAL | F_SEAL_SHRINK |
                               F_SEAL_GROW | F_SEAL_WRITE;
    int readable_fd = reopen_pinned_regular_readonly(path_fd);
    int snapshot_fd = memfd_create("ploinky-ro-data", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    int installed_seals;
    size_t total = 0;

    if (snapshot_fd < 0) {
        close(readable_fd);
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot create sealed read-only data snapshot");
    }
    for (;;) {
        ssize_t count = read(readable_fd, buffer, sizeof(buffer));
        size_t written = 0;
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count < 0) {
            close(readable_fd);
            close(snapshot_fd);
            fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
                 "cannot read pinned read-only data source");
        }
        if (count == 0) {
            break;
        }
        if ((size_t)count > MAX_RO_DATA_FILE_BYTES - total) {
            close(readable_fd);
            close(snapshot_fd);
            fail(EXIT_PATH_INVALID, "PLOINKY_PATH_INVALID",
                 "read-only data source exceeds its fixed byte limit");
        }
        total += (size_t)count;
        while (written < (size_t)count) {
            ssize_t result = write(snapshot_fd, buffer + written,
                                   (size_t)count - written);
            if (result < 0 && errno == EINTR) {
                continue;
            }
            if (result <= 0) {
                close(readable_fd);
                close(snapshot_fd);
                fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
                     "cannot populate sealed read-only data snapshot");
            }
            written += (size_t)result;
        }
    }
    close(readable_fd);
    if (lseek(snapshot_fd, 0, SEEK_SET) != 0 ||
        fcntl(snapshot_fd, F_ADD_SEALS, required_seals) != 0) {
        close(snapshot_fd);
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot seal read-only data snapshot");
    }
    installed_seals = fcntl(snapshot_fd, F_GET_SEALS);
    if (installed_seals < 0 ||
        (installed_seals & required_seals) != required_seals) {
        close(snapshot_fd);
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot verify read-only data snapshot seals");
    }
    return snapshot_fd;
#else
    (void)path_fd;
    fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
         "Linux sealed memfd support is required for read-only data snapshots");
#endif
}

static void open_mount_sources(struct launch *launch)
{
    size_t workspace_prefix_length = strlen(PLOINKY_WORKSPACE_ROOT);
    int workspace_fd = -1;
    int filesystem_fd = -1;
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        struct mount *mount = &launch->mounts[i];

        if (!mount_needs_fd(mount)) {
            continue;
        }

        if (mount->kind == MOUNT_WORKSPACE || mount->kind == MOUNT_WORKDIR ||
            (mount->kind == MOUNT_HOME &&
             mount->home_source_kind == HOME_SOURCE_SANDBOX_WORKSPACE_V2) ||
            ((mount->kind == MOUNT_RO_PATH || mount->kind == MOUNT_RO_DATA_PATH) &&
             mount->source_length > workspace_prefix_length &&
             memcmp(mount->source, PLOINKY_WORKSPACE_ROOT,
                    workspace_prefix_length) == 0 &&
             mount->source[workspace_prefix_length] == '/')) {
            if (workspace_fd < 0) {
                workspace_fd = open_workspace_root(
                    mount->kind == MOUNT_HOME
                        ? EXIT_HOME_STATE_INCOMPATIBLE
                        : EXIT_PATH_INVALID,
                    mount->kind == MOUNT_HOME
                        ? "PLOINKY_HOME_STATE_INCOMPATIBLE"
                        : "PLOINKY_WORKSPACE_INVALID");
            }
        }

        if (mount->kind == MOUNT_WORKSPACE) {
            mount->fd = dup(workspace_fd);
            if (mount->fd >= 0) {
                fcntl(mount->fd, F_SETFD, FD_CLOEXEC);
            }
        } else if (mount->kind == MOUNT_WORKDIR) {
            char *relative = copy_string(mount->source, mount->source_length,
                                         "PLOINKY_PATH_INVALID");
            mount->fd = openat2_beneath(workspace_fd, relative, true,
                                        EXIT_WORKDIR_INVALID,
                                        "PLOINKY_WORKDIR_INVALID");
            free(relative);
        } else if (mount->kind == MOUNT_HOME) {
            char *relative;
            int root_fd;

            if (mount->home_source_kind == HOME_SOURCE_SANDBOX_WORKSPACE_V2) {
                relative = sandbox_home_relative_path(mount);
                root_fd = workspace_fd;
            } else if (mount->home_source_kind == HOME_SOURCE_CONTAINER_NATIVE) {
                if (filesystem_fd < 0) {
                    filesystem_fd = open_filesystem_root(
                        EXIT_HOME_STATE_INCOMPATIBLE,
                        "PLOINKY_HOME_STATE_INCOMPATIBLE");
                }
                relative = strdup("root");
                if (relative == NULL) {
                    fail(EXIT_HOME_STATE_INCOMPATIBLE,
                         "PLOINKY_HOME_STATE_INCOMPATIBLE",
                         "cannot allocate the derived container HOME path");
                }
                root_fd = filesystem_fd;
            } else {
                fail(EXIT_HOME_STATE_INCOMPATIBLE,
                     "PLOINKY_HOME_STATE_INCOMPATIBLE",
                     "HOME source kind was not retained exactly");
            }
            mount->fd = openat2_beneath(
                root_fd, relative, true, EXIT_HOME_STATE_INCOMPATIBLE,
                "PLOINKY_HOME_STATE_INCOMPATIBLE");
            free(relative);
        } else if (mount->kind == MOUNT_RO_PATH ||
                   mount->kind == MOUNT_RO_DATA_PATH) {
            char *relative;
            bool inside_workspace =
                mount->source_length > workspace_prefix_length &&
                memcmp(mount->source, PLOINKY_WORKSPACE_ROOT,
                       workspace_prefix_length) == 0 &&
                mount->source[workspace_prefix_length] == '/';
            if (inside_workspace) {
                relative = copy_path_without_prefix(
                    mount->source, mount->source_length,
                    workspace_prefix_length + 1);
                mount->fd = openat2_beneath(workspace_fd, relative,
                                            mount->source_type == SOURCE_DIRECTORY,
                                            EXIT_PATH_INVALID,
                                            "PLOINKY_PATH_INVALID");
            } else {
                if (filesystem_fd < 0) {
                    filesystem_fd = open_filesystem_root(
                        EXIT_PATHFD_UNAVAILABLE,
                        "PLOINKY_PATHFD_UNAVAILABLE");
                }
                relative = copy_path_without_prefix(mount->source,
                                                    mount->source_length, 1);
                mount->fd = openat2_beneath(filesystem_fd, relative,
                                            mount->source_type == SOURCE_DIRECTORY,
                                            EXIT_PATH_INVALID,
                                            "PLOINKY_PATH_INVALID");
            }
            free(relative);
        }

        if (mount->fd < 0) {
            fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
                 "cannot retain mount source fd");
        }
        require_source_type(mount->fd, mount->source_type,
                            mount->kind == MOUNT_WORKDIR
                                ? EXIT_WORKDIR_INVALID
                                : mount->kind == MOUNT_HOME
                                    ? EXIT_HOME_STATE_INCOMPATIBLE
                                    : EXIT_PATH_INVALID,
                            mount->kind == MOUNT_WORKDIR
                                ? "PLOINKY_WORKDIR_INVALID"
                                : mount->kind == MOUNT_HOME
                                    ? "PLOINKY_HOME_STATE_INCOMPATIBLE"
                                    : "PLOINKY_PATH_INVALID");
        if (mount->kind == MOUNT_RO_DATA_PATH) {
            int snapshot_fd = snapshot_pinned_regular_readonly(mount->fd);
            close(mount->fd);
            mount->fd = snapshot_fd;
        }
        if (mount->kind == MOUNT_HOME) {
            validate_home_directory(mount);
        }
    }
    if (workspace_fd >= 0) {
        close(workspace_fd);
    }
    if (filesystem_fd >= 0) {
        close(filesystem_fd);
    }
}

static void secure_zero(void *buffer, size_t length)
{
    volatile unsigned char *bytes = buffer;
    while (length-- > 0) {
        *bytes++ = 0;
    }
}

static _Noreturn void credential_transport_fail(unsigned char *buffer,
                                                size_t buffer_length,
                                                const char *message)
{
    secure_zero(buffer, buffer_length);
    fail(EXIT_PROTOCOL_INVALID, "PLOINKY_CREDENTIAL_TRANSPORT_INVALID",
         "%s", message);
}

static void internalize_credential_pipe(struct launch *launch)
{
    enum { MAX_CREDENTIAL_BYTES = 4096 };
    unsigned char credential[MAX_CREDENTIAL_BYTES + 1];
    size_t used = 0;
    int internal_pipe[2] = {-1, -1};
    int target_fd;

    if (!launch->has_credential_fd) {
        return;
    }
    target_fd = launch->credential_fd;
    for (;;) {
        ssize_t count = read(target_fd, credential + used,
                             sizeof(credential) - used);
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            credential_transport_fail(credential, sizeof(credential),
                                      "cannot read parent credential IPC to EOF");
        }
        if (count == 0) {
            break;
        }
        used += (size_t)count;
        if (used > MAX_CREDENTIAL_BYTES) {
            credential_transport_fail(credential, sizeof(credential),
                                      "credential descriptor exceeds 4096 bytes");
        }
    }
    if (used == 0) {
        credential_transport_fail(credential, sizeof(credential),
                                  "credential descriptor is empty");
    }
    if (close(target_fd) != 0) {
        credential_transport_fail(credential, sizeof(credential),
                                  "cannot close parent credential IPC fd");
    }

#ifdef __linux__
    if (pipe2(internal_pipe, O_CLOEXEC) != 0) {
        credential_transport_fail(credential, sizeof(credential),
                                  "cannot create internal credential pipe");
    }
#else
    credential_transport_fail(credential, sizeof(credential),
                              "Linux pipe2 is required for credential transport");
#endif

#ifdef F_GETPIPE_SZ
    {
        int capacity = fcntl(internal_pipe[1], F_GETPIPE_SZ);
        if (capacity < 0 || (size_t)capacity < used) {
            close(internal_pipe[0]);
            close(internal_pipe[1]);
            credential_transport_fail(credential, sizeof(credential),
                                      "internal credential pipe capacity is insufficient");
        }
    }
#endif
    {
        size_t written = 0;
        while (written < used) {
            ssize_t count = write(internal_pipe[1], credential + written,
                                  used - written);
            if (count < 0 && errno == EINTR) {
                continue;
            }
            if (count <= 0) {
                close(internal_pipe[0]);
                close(internal_pipe[1]);
                credential_transport_fail(credential, sizeof(credential),
                                          "cannot fill internal credential pipe");
            }
            written += (size_t)count;
        }
    }
    secure_zero(credential, sizeof(credential));
    if (close(internal_pipe[1]) != 0) {
        close(internal_pipe[0]);
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_CREDENTIAL_TRANSPORT_INVALID",
             "cannot close internal credential pipe writer");
    }
    if (internal_pipe[0] != target_fd) {
        if (dup2(internal_pipe[0], target_fd) < 0) {
            close(internal_pipe[0]);
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_CREDENTIAL_TRANSPORT_INVALID",
                 "cannot install internal credential pipe at the declared fd");
        }
        close(internal_pipe[0]);
    }
    if (fcntl(target_fd, F_SETFD, FD_CLOEXEC) != 0) {
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot retain internal credential pipe fd");
    }
    require_anonymous_ipc_fd(target_fd, "internal credential pipe fd");
    {
        struct stat status;
        if (fstat(target_fd, &status) != 0 || !S_ISFIFO(status.st_mode)) {
            fail(EXIT_PROTOCOL_INVALID, "PLOINKY_CREDENTIAL_TRANSPORT_INVALID",
                 "bwrap credential source is not an actual pipe");
        }
    }
}

static bool fd_is_preserved(const struct launch *launch, int fd)
{
    size_t i;
    for (i = 0; i < launch->mount_count; i++) {
        if (mount_needs_fd(&launch->mounts[i]) && launch->mounts[i].fd == fd) {
            return true;
        }
    }
    for (i = 0; i < launch->preserved_fd_count; i++) {
        if (launch->preserved_fds[i] == fd) {
            return true;
        }
    }
    return false;
}

static void make_preserved_fds_inheritable(const struct launch *launch)
{
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        if (!mount_needs_fd(&launch->mounts[i])) {
            continue;
        }
        if (fcntl(launch->mounts[i].fd, F_SETFD, 0) != 0) {
            fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
                 "cannot retain a mount source fd across exec");
        }
    }
    for (i = 0; i < launch->preserved_fd_count; i++) {
        if (fcntl(launch->preserved_fds[i], F_SETFD, 0) != 0) {
            fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
                 "cannot retain a data fd across exec");
        }
    }
}

static void close_unlisted_fds(const struct launch *launch)
{
    DIR *directory = opendir("/proc/self/fd");
    struct dirent *entry;
    int inventory_fd;

    if (directory == NULL) {
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot inventory inherited file descriptors");
    }
    inventory_fd = dirfd(directory);
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        char *end = NULL;
        long parsed;

        errno = 0;
        parsed = strtol(entry->d_name, &end, 10);
        if (errno != 0 || end == entry->d_name || *end != '\0' ||
            parsed < 3 || parsed > INT_MAX) {
            continue;
        }
        if ((int)parsed != inventory_fd &&
            !fd_is_preserved(launch, (int)parsed)) {
            close((int)parsed);
        }
    }
    if (errno != 0) {
        closedir(directory);
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot complete inherited file descriptor inventory");
    }
    if (closedir(directory) != 0) {
        fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
             "cannot close inherited file descriptor inventory");
    }
}

static char **build_bwrap_argv(struct launch *launch)
{
    size_t maximum = 2 + launch->arg_count + launch->mount_count * 5;
    char **argv = calloc(maximum, sizeof(char *));
    size_t count = 0;
    size_t i;

    if (argv == NULL) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "cannot allocate bwrap argv");
    }
    argv[count++] = (char *)PLOINKY_BWRAP_PATH;
    for (i = 0; i < launch->record_count; i++) {
        struct record *record = &launch->records[i];
        if (record->type == RECORD_ARG) {
            argv[count++] = launch->args[record->mount_index];
        } else if (record->type != RECORD_PREEXEC_BARRIER) {
            struct mount *mount = &launch->mounts[record->mount_index];
            if (mount->kind == MOUNT_RO_DATA_PATH) {
                argv[count++] = "--perms";
                argv[count++] = "0444";
                argv[count++] = "--ro-bind-data";
                snprintf(mount->fd_string, sizeof(mount->fd_string), "%d", mount->fd);
                argv[count++] = mount->fd_string;
                argv[count++] = mount->target;
            } else if (mount_needs_fd(mount)) {
                argv[count++] = mount->writable ? "--bind-fd" : "--ro-bind-fd";
                snprintf(mount->fd_string, sizeof(mount->fd_string), "%d", mount->fd);
                argv[count++] = mount->fd_string;
                argv[count++] = mount->target;
            } else if (mount->kind == MOUNT_DIR) {
                argv[count++] = "--dir";
                argv[count++] = mount->target;
            } else if (mount->kind == MOUNT_TMPFS) {
                argv[count++] = "--tmpfs";
                argv[count++] = mount->target;
            } else if (mount->kind == MOUNT_PROC) {
                argv[count++] = "--proc";
                argv[count++] = mount->target;
            } else if (mount->kind == MOUNT_DEV) {
                argv[count++] = "--dev";
                argv[count++] = mount->target;
            } else if (mount->kind == MOUNT_SYMLINK) {
                argv[count++] = "--symlink";
                argv[count++] = (char *)mount->source;
                argv[count++] = mount->target;
            } else {
                fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
                     "unsupported typed filesystem record");
            }
        }
    }
    argv[count] = NULL;
    return argv;
}

static void run_preexec_barrier(struct launch *launch)
{
    unsigned char ready = 'R';
    unsigned char release = 0;
    ssize_t count;

    if (!launch->has_preexec_barrier) {
        return;
    }
    do {
        count = write(launch->barrier_ready_fd, &ready, 1);
    } while (count < 0 && errno == EINTR);
    if (count != 1) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PREEXEC_BARRIER_FAILED",
             "cannot signal retained-fd readiness");
    }
    if (close(launch->barrier_ready_fd) != 0) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PREEXEC_BARRIER_FAILED",
             "cannot close pre-exec ready fd");
    }
    launch->barrier_ready_fd = -1;

    do {
        count = read(launch->barrier_release_fd, &release, 1);
    } while (count < 0 && errno == EINTR);
    if (count != 1 || release != 'G') {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PREEXEC_BARRIER_FAILED",
             "pre-exec release requires exactly the byte G");
    }
    if (close(launch->barrier_release_fd) != 0) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PREEXEC_BARRIER_FAILED",
             "cannot close pre-exec release fd");
    }
    launch->barrier_release_fd = -1;
}

static void revalidate_home_sources_after_barrier(struct launch *launch)
{
    size_t i;

    for (i = 0; i < launch->mount_count; i++) {
        if (launch->mounts[i].kind == MOUNT_HOME) {
            validate_home_directory(&launch->mounts[i]);
        }
    }
}

static void launch_bwrap(void)
{
    struct launch launch;
    char **argv;

    memset(&launch, 0, sizeof(launch));
    launch.bytes = read_descriptor(&launch.bytes_length);
    parse_descriptor(&launch);

#ifndef __linux__
    fail(EXIT_PATHFD_UNAVAILABLE, "PLOINKY_PATHFD_UNAVAILABLE",
         "Linux openat2 is required");
#endif

    open_mount_sources(&launch);
    argv = build_bwrap_argv(&launch);
    run_preexec_barrier(&launch);
    revalidate_home_sources_after_barrier(&launch);
    internalize_credential_pipe(&launch);
    make_preserved_fds_inheritable(&launch);
    close_unlisted_fds(&launch);
    execv(PLOINKY_BWRAP_PATH, argv);
    if (errno == ENOENT || errno == EACCES) {
        fail(EXIT_BWRAP_UNAVAILABLE, "PLOINKY_BWRAP_UNAVAILABLE",
             "fixed bwrap executable is unavailable");
    }
    fail(EXIT_BWRAP_EXEC_FAILED, "PLOINKY_BWRAP_EXEC_FAILED",
         "cannot execute fixed bwrap binary: %s", strerror(errno));
}

int main(int argc, char **argv)
{
    require_source_sha();

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("ploinky-bwrap-launch-v2 source-sha=%s\n", PLOINKY_SOURCE_SHA);
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--capabilities") == 0) {
        printf("ploinky-bwrap-launch-v2 source-sha=%s protocol=2 descriptor-fd=3 "
               "path-resolution=openat2-beneath-no-magiclinks-no-symlinks "
               "bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms "
               "typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file "
               "ro-data-path-hardening=sealed-memfd-ro-bind-data "
               "home-sources=sandbox-workspace-v2,container-native "
               "home-marker=ploinky-home-v2-schema-2 "
               "home-revalidation=post-barrier-G "
               "preexec-barrier=R/G credential-bound=4096\n",
               PLOINKY_SOURCE_SHA);
        return 0;
    }
    if (argc != 1) {
        fail(EXIT_PROTOCOL_INVALID, "PLOINKY_BWRAP_PROTOCOL_INVALID",
             "normal launch accepts no command-line options");
    }
    if (geteuid() != getuid() || getegid() != getgid()) {
        fail(EXIT_PRIVILEGE_INVALID, "PLOINKY_HELPER_PRIVILEGE_INVALID",
             "setuid or setgid execution is forbidden");
    }
    launch_bwrap();
    return 0;
}
