# Distribution configuration — the ONLY environment-specific strings for shipping.
#
# These are the canonical values; everything else derives from them. Referenced by
# build-binary.mjs, install.sh (repo root), and the Homebrew formula.
#
# Keep this file in sync with the same values in:
#   - install.sh                          (repo root — RELEASES_REPO default)
#   - packaging/homebrew/cryptocadet.rb   (homepage + url)
#   - README.md                            (Install section)

# Canonical CryptoCadet domain that hosts install.sh:
#   curl -fsSL https://${CRYPTOCADET_DOMAIN}/install.sh | sh
CRYPTOCADET_DOMAIN="cryptocadet.app"

# GitHub "<org>/<repo>" that hosts the SOURCE + release binaries + SHA256SUMS + install.sh.
#   https://github.com/${CRYPTOCADET_RELEASES_REPO}/releases/download/v<ver>/<asset>
CRYPTOCADET_RELEASES_REPO="thetechjd/cryptocadet-cli"

# Homebrew tap — a plain repo under the existing thetechjd account (NO GitHub org needed, exactly
# like RDK's homebrew-rdk). Homebrew strips the "homebrew-" prefix and derives the first command
# segment from the repo OWNER, so repo github.com/thetechjd/homebrew-cryptocadet-cli => tap
# "thetechjd/cryptocadet-cli" and:
#   brew install thetechjd/cryptocadet-cli/cryptocadet
# Namespaces are independent: source+releases=thetechjd, npm scope=@cryptocadet, brew owner=thetechjd.
CRYPTOCADET_TAP_REPO="thetechjd/homebrew-cryptocadet-cli"

# Binary name installed onto the user's PATH (matches package.json "bin").
CRYPTOCADET_BIN="cryptocadet"
