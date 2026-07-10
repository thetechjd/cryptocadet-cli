#!/bin/sh
# CryptoCadet installer (macOS / Linux) — NODE-ENVIRONMENT build.
#
#   curl -fsSL https://cryptocadet.app/install.sh | sh
#
# The CLI is JavaScript. Instead of a per-platform compiled binary (fragile V8 bytecode, no
# Windows path), this sets up a self-contained Node environment and installs the same npm
# package that `npm i -g` and Homebrew use — so it behaves identically everywhere. It:
#   1. installs a private, pinned Node (latest v24) under ~/.cryptocadet-cli/node, SHA256-verified
#      against nodejs.org (unless you opt into a suitable system Node),
#   2. npm-installs @cryptocadet/cli (+ its optional native keychain) under ~/.cryptocadet-cli/app,
#   3. drops `cryptocadet` / `ccx` launchers on your PATH that run that Node against the CLI.
#
# Windows: use PowerShell -> https://cryptocadet.app/install.ps1  (or: npm i -g @cryptocadet/cli)
# POSIX sh — no bashisms.
set -eu

# ── Config (override via env) ───────────────────────────────────────────────────────────────
INSTALL_DIR="${CRYPTOCADET_INSTALL_DIR:-$HOME/.cryptocadet-cli}"
BIN_DIR="${CRYPTOCADET_BIN_DIR:-}"                      # default chosen below
NPM_SPEC="${CRYPTOCADET_NPM_SPEC:-@cryptocadet/cli}"    # pre-publish: github:thetechjd/cryptocadet-cli
NODE_CHANNEL="${CRYPTOCADET_NODE_CHANNEL:-latest-v24.x}"
USE_SYSTEM_NODE="${CRYPTOCADET_USE_SYSTEM_NODE:-0}"     # 1 = use a system Node >= 22.5 if present
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5
# ────────────────────────────────────────────────────────────────────────────────────────────

err()  { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

download() { # <url> <dest>
  if have curl; then curl -fsSL "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else err "need curl or wget"; fi
}
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else err "no sha256 tool (sha256sum/shasum) — refusing unverified download"; fi
}

node_platform() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in
    Darwin) os_tag=darwin ;;
    Linux)  os_tag=linux ;;
    *) err "unsupported OS: $os (Windows: use install.ps1 or npm i -g @cryptocadet/cli)" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch_tag=arm64 ;;
    x86_64|amd64)  arch_tag=x64 ;;
    *) err "unsupported architecture: $arch" ;;
  esac
  printf '%s-%s' "$os_tag" "$arch_tag"
}

system_node_ok() {
  have node || return 1
  v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  maj=$(printf '%s' "$v" | cut -d. -f1); min=$(printf '%s' "$v" | cut -d. -f2)
  [ "$maj" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$maj" -eq "$MIN_NODE_MAJOR" ] && [ "$min" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

# Bootstrap a private, pinned Node into $INSTALL_DIR/node. Idempotent.
bootstrap_node() {
  if [ -x "$INSTALL_DIR/node/bin/node" ]; then info "using cached Node at $INSTALL_DIR/node"; return; fi
  plat=$(node_platform)
  base="https://nodejs.org/dist/${NODE_CHANNEL}"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  info "resolving latest Node (${NODE_CHANNEL}, ${plat}) ..."
  download "${base}/SHASUMS256.txt" "${tmp}/SHASUMS256.txt"
  line=$(grep "  node-v[0-9.]*-${plat}\.tar\.gz\$" "${tmp}/SHASUMS256.txt" | head -1)
  [ -n "$line" ] || err "could not find a Node build for ${plat} in ${base}"
  file=$(printf '%s' "$line" | awk '{print $2}')
  want=$(printf '%s' "$line" | awk '{print $1}')
  info "downloading ${file} ..."
  download "${base}/${file}" "${tmp}/${file}"
  got=$(sha256_of "${tmp}/${file}")
  [ "$want" = "$got" ] || err "Node checksum mismatch (want $want got $got) — aborting"
  info "extracting Node ..."
  mkdir -p "${INSTALL_DIR}"
  rm -rf "${INSTALL_DIR}/node" "${INSTALL_DIR}/node.tmp"
  mkdir -p "${INSTALL_DIR}/node.tmp"
  tar -xzf "${tmp}/${file}" -C "${INSTALL_DIR}/node.tmp" --strip-components=1
  mv "${INSTALL_DIR}/node.tmp" "${INSTALL_DIR}/node"
}

main() {
  mkdir -p "$INSTALL_DIR"

  if [ "$USE_SYSTEM_NODE" = "1" ] && system_node_ok; then
    NODE_BIN=$(command -v node)
    NPM_PATH_DIR=$(dirname "$NODE_BIN")
    info "using system Node $(node -p process.versions.node)"
  else
    bootstrap_node
    NODE_BIN="$INSTALL_DIR/node/bin/node"
    NPM_PATH_DIR="$INSTALL_DIR/node/bin"
  fi

  info "installing ${NPM_SPEC} ..."
  rm -rf "$INSTALL_DIR/app"; mkdir -p "$INSTALL_DIR/app"
  # Use the chosen Node's npm; --omit=dev keeps it lean (published tarball ships prebuilt dist).
  PATH="$NPM_PATH_DIR:$PATH" npm install --prefix "$INSTALL_DIR/app" --omit=dev --no-fund --no-audit "$NPM_SPEC" >&2 \
    || err "npm install of ${NPM_SPEC} failed"

  ENTRY="$INSTALL_DIR/app/node_modules/@cryptocadet/cli/dist/cli/bin.js"
  [ -f "$ENTRY" ] || err "installed package is missing $ENTRY"

  # Where to put the launchers. If a `cryptocadet` is already on PATH (e.g. a stale binary
  # from an older install), install OVER it — otherwise it keeps shadowing us on PATH and you
  # get the old binary. Falling back to ~/.local/bin only when nothing pre-exists.
  existing=$(command -v cryptocadet 2>/dev/null || true)
  if [ -z "$BIN_DIR" ]; then
    if [ -n "$existing" ]; then BIN_DIR=$(dirname "$existing")
    elif [ -w "/usr/local/bin" ]; then BIN_DIR="/usr/local/bin"
    else BIN_DIR="$HOME/.local/bin"; fi
  fi

  # Use sudo only if we can't write BIN_DIR ourselves.
  SUDO=""
  mkdir -p "$BIN_DIR" 2>/dev/null || { SUDO="sudo"; $SUDO mkdir -p "$BIN_DIR"; }
  [ -w "$BIN_DIR" ] || SUDO="sudo"
  if [ -n "$SUDO" ]; then
    have sudo || err "need write access to $BIN_DIR — re-run with sudo, or set CRYPTOCADET_BIN_DIR to a writable dir"
    info "installing launchers to $BIN_DIR (sudo) ..."
  fi

  for name in cryptocadet ccx; do
    tmp=$(mktemp)
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$ENTRY" > "$tmp"
    chmod +x "$tmp"
    $SUDO mv "$tmp" "$BIN_DIR/$name"
    # Remove any OTHER copy that sits earlier on PATH and would shadow this one.
    other=$(command -v "$name" 2>/dev/null || true)
    if [ -n "$other" ] && [ "$other" != "$BIN_DIR/$name" ]; then
      info "removing shadowing $name at $other"
      if [ -w "$(dirname "$other")" ]; then rm -f "$other"
      elif have sudo; then sudo rm -f "$other"; fi
    fi
  done
  hash -r 2>/dev/null || true

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) info "note: ${BIN_DIR} is not on your PATH — add it:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
  esac

  printf '\nCryptoCadet installed.\n  node: %s\n  bin:  %s/cryptocadet\nGet started:\n  cryptocadet init\n' \
    "$("$NODE_BIN" -p process.versions.node)" "$BIN_DIR" >&2
}

main "$@"
