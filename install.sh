#!/bin/sh
# CryptoCadet installer — lives at the CLI repo root; served from https://cryptocadet.app/install.sh
# (and reachable raw at https://raw.githubusercontent.com/thetechjd/cryptocadet-cli/main/install.sh).
#
#   curl -fsSL https://cryptocadet.app/install.sh | sh
#
# Detects OS/arch, downloads the matching release archive, VERIFIES it against SHA256SUMS,
# then installs the `cryptocadet` binary to /usr/local/bin (or ~/.local/bin without sudo).
# An unverified binary is NEVER placed on PATH. POSIX sh — no bashisms.
set -eu

# ── Config ────────────────────────────────────────────────────────────────────────────────
# Canonical values in packaging/dist.config.sh; keep in sync.
RELEASES_REPO="${CRYPTOCADET_RELEASES_REPO:-thetechjd/cryptocadet-cli}"
# Pin to a release, or leave "latest" to resolve the newest published tag.
VERSION="${CRYPTOCADET_VERSION:-latest}"
BIN_NAME="cryptocadet"
# ──────────────────────────────────────────────────────────────────────────────────────────

err() { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── Detect OS/arch and map to a release asset (must match build-binary.mjs TARGETS) ─────────
osArchToAsset() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os_tag=macos ;;
    Linux)  os_tag=linux ;;
    *) err "unsupported OS: $os (macOS and Linux only; on Windows use: npm i -g @cryptocadet/cli)" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch_tag=arm64 ;;
    x86_64|amd64)  arch_tag=x64 ;;
    *) err "unsupported architecture: $arch" ;;
  esac
  # Linux arm64 binary exists; macOS + Linux both ship arm64 and x64.
  printf '%s-%s-%s' "$BIN_NAME" "$os_tag" "$arch_tag"
}

# ── Downloader (curl or wget) ───────────────────────────────────────────────────────────────
download() { # download <url> <dest>
  if have curl; then curl -fsSL "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else err "need curl or wget to download"; fi
}

resolve_version() {
  [ "$VERSION" != "latest" ] && { printf '%s' "$VERSION"; return; }
  # Resolve the latest tag from GitHub's redirect without needing jq.
  api="https://github.com/${RELEASES_REPO}/releases/latest"
  if have curl; then
    tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$api" | sed 's#.*/tag/##')
  else
    tag=$(wget -S --spider "$api" 2>&1 | sed -n 's#.*Location: .*/tag/##p' | tail -1 | tr -d '\r')
  fi
  [ -n "$tag" ] || err "could not resolve latest version; set CRYPTOCADET_VERSION"
  printf '%s' "$tag"
}

# ── sha256 verification (never install unverified) ──────────────────────────────────────────
sha256_of() { # sha256_of <file>  -> hex to stdout
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else err "no sha256 tool (need sha256sum or shasum) — refusing to install unverified binary"; fi
}

main() {
  asset=$(osArchToAsset)
  archive="${asset}.tar.gz"
  ver=$(resolve_version)
  base="https://github.com/${RELEASES_REPO}/releases/download/${ver}"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  info "CryptoCadet ${ver} — ${asset}"
  info "downloading ${archive} ..."
  download "${base}/${archive}" "${tmp}/${archive}"
  download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"

  info "verifying checksum ..."
  want=$(grep " ${archive}\$" "${tmp}/SHA256SUMS" | awk '{print $1}')
  [ -n "$want" ] || err "no checksum for ${archive} in SHA256SUMS — aborting"
  got=$(sha256_of "${tmp}/${archive}")
  [ "$want" = "$got" ] || err "checksum mismatch for ${archive} (want ${want}, got ${got}) — aborting"

  tar -xzf "${tmp}/${archive}" -C "${tmp}"
  [ -f "${tmp}/${BIN_NAME}" ] || err "archive did not contain ${BIN_NAME}"
  chmod +x "${tmp}/${BIN_NAME}"

  # Prefer /usr/local/bin; fall back to ~/.local/bin when it isn't writable and sudo is absent.
  dest="/usr/local/bin"
  if [ -w "$dest" ]; then
    mv "${tmp}/${BIN_NAME}" "${dest}/${BIN_NAME}"
  elif have sudo; then
    info "installing to ${dest} (sudo) ..."
    sudo mv "${tmp}/${BIN_NAME}" "${dest}/${BIN_NAME}"
  else
    dest="${HOME}/.local/bin"
    mkdir -p "$dest"
    mv "${tmp}/${BIN_NAME}" "${dest}/${BIN_NAME}"
    case ":${PATH}:" in
      *":${dest}:"*) ;;
      *) info "note: ${dest} is not on your PATH — add it: export PATH=\"${dest}:\$PATH\"" ;;
    esac
  fi

  printf '\nCryptoCadet installed. Get started:\n  cryptocadet init\n'
}

main "$@"
