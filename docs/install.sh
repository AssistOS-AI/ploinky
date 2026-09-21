#!/usr/bin/env bash
#
# Ploinky bootstrap installer.
#
#   curl -fsSL https://www.ploinky.com/install.sh | bash
#
# It detects Linux or macOS, checks Node.js 22+, Podman, Git and the optional
# lite sandbox (bubblewrap on Linux, seatbelt on macOS), asks before installing
# or upgrading what it can, and clones Ploinky under ~/.local/share/ploinky/src
# when no checkout exists. If a ploinky command is already on PATH it is left
# untouched; otherwise the existing or new checkout's bin directory is added to
# PATH. Missing prerequisites become non-blocking warnings with manual
# instructions.
#
set -euo pipefail

REPO_URL="https://github.com/AssistOS-AI/ploinky.git"
NODE_MIN_MAJOR=22
PODMAN_MIN_VERSION="5.4.0"
APP_ROOT="$HOME/.local/share/ploinky"
NODE_DIR="$APP_ROOT/node"

DRY_RUN=0
CHECKOUT_DIR="$APP_ROOT/src"
WARNINGS=""
INPUT_SOURCE=""
SUDO=()

[ "${PLOINKY_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

log()  { printf 'ploinky: %s\n' "$*"; }
info() { printf 'ploinky: %s\n' "$*"; }
warn() {
    printf 'ploinky: WARNING: %s\n' "$*" >&2
    WARNINGS="${WARNINGS}  - $*
"
}

run() {
    if [ "$DRY_RUN" = 1 ]; then
        printf '  [dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

if (: < /dev/tty) 2>/dev/null; then
    INPUT_SOURCE="/dev/tty"
fi
if [ "$(id -u)" -ne 0 ]; then
    SUDO=(sudo)
fi

# --- platform -------------------------------------------------------------
OS_NAME="$(uname -s)"
ARCH_RAW="$(uname -m)"
case "$OS_NAME" in
    Linux) PLATFORM="linux"; NODE_OS="linux" ;;
    Darwin) PLATFORM="macos"; NODE_OS="darwin" ;;
    *) printf 'ploinky: unsupported operating system: %s (Linux and macOS are supported).\n' "$OS_NAME" >&2; exit 1 ;;
esac
case "$ARCH_RAW" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) printf 'ploinky: unsupported CPU architecture: %s\n' "$ARCH_RAW" >&2; exit 1 ;;
esac

confirm() {
    [ -n "$INPUT_SOURCE" ] || return 1
    printf '%s [y/N] ' "$1" > /dev/tty
    local answer=""
    IFS= read -r answer < /dev/tty || answer=""
    case "$answer" in
        y|Y|yes|YES|Yes) return 0 ;;
        *) return 1 ;;
    esac
}

detect_rc_file() {
    local shell_name
    shell_name="$(basename "${SHELL:-bash}")"
    case "$shell_name" in
        zsh) printf '%s' "$HOME/.zshrc" ;;
        bash)
            if [ "$PLATFORM" = "macos" ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi
            ;;
        *) printf '%s' "$HOME/.profile" ;;
    esac
}

version_ge() {
    local actual="${1#v}" required="${2#v}"
    local IFS=.
    local -a A B
    A=($actual)
    B=($required)
    local i x y
    for i in 0 1 2; do
        x="${A[$i]:-0}"; y="${B[$i]:-0}"
        x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
        [ -z "$x" ] && x=0
        [ -z "$y" ] && y=0
        if [ "$x" -gt "$y" ]; then return 0; fi
        if [ "$x" -lt "$y" ]; then return 1; fi
    done
    return 0
}

detect_pkg_manager() {
    local pm
    for pm in apt-get dnf yum pacman zypper apk; do
        if command -v "$pm" >/dev/null 2>&1; then printf '%s' "$pm"; return 0; fi
    done
    return 1
}

pkg_install() {
    local pm="$1"; shift
    case "$pm" in
        apt-get) run ${SUDO[@]+"${SUDO[@]}"} apt-get update && run ${SUDO[@]+"${SUDO[@]}"} apt-get install -y "$@" ;;
        dnf)     run ${SUDO[@]+"${SUDO[@]}"} dnf install -y "$@" ;;
        yum)     run ${SUDO[@]+"${SUDO[@]}"} yum install -y "$@" ;;
        pacman)  run ${SUDO[@]+"${SUDO[@]}"} pacman -S --noconfirm "$@" ;;
        zypper)  run ${SUDO[@]+"${SUDO[@]}"} zypper --non-interactive install "$@" ;;
        apk)     run ${SUDO[@]+"${SUDO[@]}"} apk add "$@" ;;
        *) return 1 ;;
    esac
}

verify_sha256() {
    local file="$1" expected="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null 2>&1
    elif command -v shasum >/dev/null 2>&1; then
        printf '%s  %s\n' "$expected" "$file" | shasum -a 256 -c - >/dev/null 2>&1
    else
        return 1
    fi
}

# --- Node.js --------------------------------------------------------------
persist_user_bin() {
    local user_bin="$HOME/.local/bin" rc
    rc="$(detect_rc_file)"
    add_rc_block "$rc" "$user_bin"
    export PATH="$user_bin:$PATH"
    info "Added $user_bin to PATH in $rc"
}

install_node() {
    if [ "$DRY_RUN" = 1 ]; then
        printf '  [dry-run] install Node.js %s.x into %s and add %s to PATH\n' "$NODE_MIN_MAJOR" "$NODE_DIR" "$HOME/.local/bin"
        return 0
    fi
    if [ "$PLATFORM" = "macos" ] && command -v brew >/dev/null 2>&1; then
        run brew install "node@${NODE_MIN_MAJOR}" || return 1
        run brew link --overwrite --force "node@${NODE_MIN_MAJOR}" || true
        return 0
    fi
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is required to download Node.js."
        return 1
    fi
    local base="https://nodejs.org/dist/latest-v${NODE_MIN_MAJOR}.x"
    log "Downloading Node.js ${NODE_MIN_MAJOR}.x from nodejs.org"
    local shasums match entry sha file tmp
    shasums="$(curl -fsSL "$base/SHASUMS256.txt" 2>/dev/null || true)"
    match="$(printf '%s\n' "$shasums" | grep -E "node-v${NODE_MIN_MAJOR}\.[0-9]+\.[0-9]+-${NODE_OS}-${ARCH}\.tar\.xz$" || true)"
    entry="$(printf '%s\n' "$match" | head -n 1)"
    sha="$(printf '%s\n' "$entry" | awk '{print $1}')"
    file="$(printf '%s\n' "$entry" | awk '{print $2}')"
    if [ -z "$file" ]; then
        warn "Could not resolve a Node.js ${NODE_MIN_MAJOR}.x build for ${NODE_OS}/${ARCH}."
        return 1
    fi
    tmp="$(mktemp -d)"
    if run curl -fsSL "$base/$file" -o "$tmp/$file" && verify_sha256 "$tmp/$file" "$sha"; then
        run mkdir -p "$NODE_DIR"
        run tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
        run mkdir -p "$HOME/.local/bin"
        local b
        for b in node npm npx corepack; do
            [ -e "$NODE_DIR/bin/$b" ] && run ln -sfn "$NODE_DIR/bin/$b" "$HOME/.local/bin/$b"
        done
        rm -rf "$tmp"
        persist_user_bin
        return 0
    fi
    rm -rf "$tmp"
    warn "Node.js download or checksum verification failed."
    return 1
}

check_node() {
    if command -v node >/dev/null 2>&1; then
        local current
        current="$(node --version 2>/dev/null || true)"
        if version_ge "$current" "$NODE_MIN_MAJOR"; then
            info "Node.js $current detected."
            return 0
        fi
        info "Node.js $current is older than the required v${NODE_MIN_MAJOR}."
        if confirm "Install Node.js ${NODE_MIN_MAJOR}.x now (no sudo needed)?"; then
            if install_node; then
                info "Node.js $(node --version 2>/dev/null) installed."
                return 0
            fi
        fi
        warn "Install Node.js ${NODE_MIN_MAJOR}+ manually from https://nodejs.org/en/download, then rerun this script."
        return 1
    fi
    info "Node.js 22 or newer is required but node was not found."
    if confirm "Install Node.js ${NODE_MIN_MAJOR}.x now (no sudo needed)?"; then
        if install_node; then
            info "Node.js $(node --version 2>/dev/null) installed."
            return 0
        fi
    fi
    warn "Install Node.js ${NODE_MIN_MAJOR}+ manually from https://nodejs.org/en/download, then rerun this script."
    return 1
}

# --- Git ------------------------------------------------------------------
check_git() {
    if command -v git >/dev/null 2>&1; then
        info "git $(git --version 2>/dev/null | awk '{print $3}') detected."
        return 0
    fi
    info "git is required to clone and update Ploinky but was not found."
    if confirm "Install git now?"; then
        if [ "$PLATFORM" = "macos" ]; then
            if command -v brew >/dev/null 2>&1; then
                run brew install git || true
            else
                run xcode-select --install || true
            fi
        else
            local pm
            pm="$(detect_pkg_manager || true)"
            [ -n "$pm" ] && pkg_install "$pm" git || true
        fi
        if command -v git >/dev/null 2>&1; then
            info "git installed."
            return 0
        fi
    fi
    warn "Install git manually, then rerun this script."
    return 1
}

# --- Podman ---------------------------------------------------------------
install_podman_linux() {
    local pm
    pm="$(detect_pkg_manager || true)"
    if [ -z "$pm" ]; then
        warn "No supported package manager found to install Podman."
        return 1
    fi
    if [ "$pm" = "apt-get" ]; then
        pkg_install "$pm" podman uidmap passt conmon crun catatonit || return 1
    else
        pkg_install "$pm" podman || return 1
    fi
    return 0
}

install_podman_macos() {
    if ! command -v brew >/dev/null 2>&1; then
        warn "Homebrew is required to install Podman on macOS. See https://brew.sh"
        return 1
    fi
    run brew install podman || return 1
    if ! podman machine inspect >/dev/null 2>&1; then
        run podman machine init || return 1
    fi
    run podman machine start || return 1
    return 0
}

check_podman() {
    if ! command -v podman >/dev/null 2>&1; then
        info "Podman was not found; the rootless outer Box needs Podman."
        if confirm "Install Podman now? (may require administrator privileges)"; then
            if [ "$PLATFORM" = "macos" ]; then
                install_podman_macos || true
            else
                install_podman_linux || true
            fi
            if command -v podman >/dev/null 2>&1; then
                info "Podman $(podman --version 2>/dev/null | awk '{print $3}') installed."
                return 0
            fi
        fi
        warn "Install Podman from https://podman.io/docs/installation, then rerun this script."
        return 1
    fi
    local current
    current="$(podman --version 2>/dev/null | awk '{print $3}' || true)"
    info "Podman $current detected."
    if [ "$PLATFORM" = "linux" ] && ! version_ge "$current" "$PODMAN_MIN_VERSION"; then
        info "Podman $current is older than the supported baseline $PODMAN_MIN_VERSION."
        if confirm "Upgrade Podman now?"; then
            install_podman_linux || true
            current="$(podman --version 2>/dev/null | awk '{print $3}' || true)"
        fi
        if ! version_ge "$current" "$PODMAN_MIN_VERSION"; then
            warn "Upgrade Podman to $PODMAN_MIN_VERSION or newer via your distribution package source or https://podman.io/docs/installation."
        fi
    fi
    return 0
}

check_subid_ranges() {
    [ "$PLATFORM" = "linux" ] || return 0
    local user
    user="$(id -un)"
    local ok=1
    if ! grep -q "^${user}:" /etc/subuid 2>/dev/null; then ok=0; fi
    if ! grep -q "^${user}:" /etc/subgid 2>/dev/null; then ok=0; fi
    if [ "$ok" = 0 ]; then
        warn "No subordinate UID/GID ranges found for '$user' in /etc/subuid and /etc/subgid."
        warn "Ask an administrator to run: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user"
        warn "Then run: podman system migrate"
    fi
}

# --- bubblewrap (optional lite sandbox, Linux) ----------------------------
check_bwrap() {
    [ "$PLATFORM" = "linux" ] || return 0
    if command -v bwrap >/dev/null 2>&1; then
        info "bubblewrap (bwrap) detected."
        return 0
    fi
    info "bubblewrap (bwrap) was not found; the optional lite sandbox needs it."
    if confirm "Install bubblewrap now?"; then
        local pm
        pm="$(detect_pkg_manager || true)"
        if [ -n "$pm" ]; then
            pkg_install "$pm" bubblewrap || true
        else
            warn "No supported package manager found to install bubblewrap."
        fi
        if command -v bwrap >/dev/null 2>&1; then
            info "bubblewrap installed."
            return 0
        fi
    fi
    warn "Install bubblewrap manually to enable the lite sandbox, then rerun this script."
    return 1
}

# --- seatbelt (optional lite sandbox, macOS) ------------------------------
check_seatbelt() {
    [ "$PLATFORM" = "macos" ] || return 0
    if command -v sandbox-exec >/dev/null 2>&1; then
        info "seatbelt (sandbox-exec) detected."
        return 0
    fi
    warn "seatbelt (sandbox-exec) was not found; the optional lite sandbox needs it."
    warn "sandbox-exec ships with macOS; if it is unavailable, use container sandboxes (podman) instead."
    return 1
}

# --- checkout and PATH ----------------------------------------------------
is_ploinky_checkout() {
    [ -n "${1:-}" ] || return 1
    [ -x "$1/bin/ploinky" ] || return 1
    [ -f "$1/package.json" ] || return 1
    grep -q '"name": *"ploinky-cloud"' "$1/package.json" 2>/dev/null
}

find_existing_checkout() {
    local d
    for d in "$APP_ROOT/src" "$PWD/ploinky" "$HOME/ploinky" "$HOME/src/ploinky" "$HOME/work/ploinky"; do
        if is_ploinky_checkout "$d"; then printf '%s\n' "$d"; return 0; fi
    done
    local hits f parent
    hits="$(find "$HOME" -maxdepth 5 -type f -path '*/bin/ploinky' -not -path '*/node_modules/*' 2>/dev/null || true)"
    local IFS='
'
    for f in $hits; do
        parent="$(dirname "$(dirname "$f")")"
        if is_ploinky_checkout "$parent"; then printf '%s\n' "$parent"; return 0; fi
    done
    return 1
}

repo_from_ploinky_path() {
    local target link
    target="$(command -v ploinky 2>/dev/null || true)"
    [ -n "$target" ] || return 1
    while [ -L "$target" ]; do
        link="$(readlink "$target" 2>/dev/null || true)"
        [ -n "$link" ] || break
        case "$link" in
            /*) target="$link" ;;
            *) target="$(dirname "$target")/$link" ;;
        esac
    done
    [ "$(basename "$target")" = "ploinky" ] || return 1
    dirname "$(dirname "$target")"
}

resolve_checkout() {
    local existing derived
    existing="$(find_existing_checkout || true)"
    if [ -n "$existing" ]; then
        CHECKOUT_DIR="$existing"
        info "Found an existing Ploinky checkout at $CHECKOUT_DIR"
        return 0
    fi
    if command -v ploinky >/dev/null 2>&1; then
        derived="$(repo_from_ploinky_path || true)"
        if [ -n "$derived" ]; then
            CHECKOUT_DIR="$derived"
            if is_ploinky_checkout "$CHECKOUT_DIR"; then
                info "Using existing Ploinky checkout at $CHECKOUT_DIR"
                return 0
            fi
            if [ -e "$CHECKOUT_DIR" ] && [ -n "$(ls -A "$CHECKOUT_DIR" 2>/dev/null)" ]; then
                warn "ploinky is on PATH at '$derived', but that is not a Ploinky checkout; installing to $APP_ROOT/src instead."
                CHECKOUT_DIR="$APP_ROOT/src"
            else
                info "Installing Ploinky into $CHECKOUT_DIR (the location ploinky resolves to on PATH)"
            fi
        fi
    fi
    if is_ploinky_checkout "$CHECKOUT_DIR"; then
        info "Using existing Ploinky checkout at $CHECKOUT_DIR"
        return 0
    fi
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] git clone ${REPO_URL} ${CHECKOUT_DIR}"
        return 0
    fi
    if ! command -v git >/dev/null 2>&1; then
        warn "Cannot clone Ploinky without git."
        return 1
    fi
    mkdir -p "$(dirname "$CHECKOUT_DIR")"
    log "Cloning Ploinky into $CHECKOUT_DIR"
    run git clone "$REPO_URL" "$CHECKOUT_DIR"
    is_ploinky_checkout "$CHECKOUT_DIR"
}

add_rc_block() {
    local rc="$1" bindir="$2" line
    line="export PATH=\"$bindir:\$PATH\""
    if [ -f "$rc" ] && grep -qF "$line" "$rc" 2>/dev/null; then
        return 0
    fi
    run mkdir -p "$(dirname "$rc")"
    if [ "$DRY_RUN" = 1 ]; then
        printf '  [dry-run] append PATH export for %s to %s\n' "$bindir" "$rc"
        return 0
    fi
    {
        printf '\n# >>> ploinky installer >>>\n'
        printf '%s\n' "$line"
        printf '# <<< ploinky installer <<<\n'
    } >> "$rc"
}

setup_path() {
    local bindir rc
    if command -v ploinky >/dev/null 2>&1; then
        info "ploinky is already available at $(command -v ploinky); leaving PATH unchanged."
        return 0
    fi
    bindir="$CHECKOUT_DIR/bin"
    rc="$(detect_rc_file)"
    add_rc_block "$rc" "$bindir"
    export PATH="$bindir:$PATH"
    info "Added $bindir to PATH in $rc"
}

# --- main -----------------------------------------------------------------
log "Platform: ${OS_NAME} (${ARCH})"
if [ "$DRY_RUN" = 1 ]; then log "Dry run: no changes will be made."; fi

GIT_OK=1
NODE_OK=1
check_git || GIT_OK=0
check_node || NODE_OK=0
check_podman || true
check_bwrap || true
check_seatbelt || true
check_subid_ranges

CHECKOUT_OK=1
resolve_checkout || CHECKOUT_OK=0

if [ "$CHECKOUT_OK" = 1 ]; then
    setup_path || true
fi

printf '\n'
if [ "$CHECKOUT_OK" = 1 ] && [ "$GIT_OK" = 1 ]; then
    log "Ploinky is installed at $CHECKOUT_DIR"
else
    warn "Ploinky could not be fully installed."
fi

if [ "$NODE_OK" != 1 ]; then
    warn "ploinky will not run until Node.js ${NODE_MIN_MAJOR}+ is available on PATH; install it, then open a new terminal."
fi

if [ -n "$WARNINGS" ]; then
    printf 'ploinky: Review these items before starting:\n' >&2
    printf '%b' "$WARNINGS" >&2
fi

cat <<'EOF'

Open a new terminal and run:

  cd /path/to/your/workspace
  ploinky start explorer
EOF
