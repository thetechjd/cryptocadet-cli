# Homebrew formula for the CryptoCadet CLI — NODE-ENVIRONMENT build (no compiled binary).
#
# The CLI is JavaScript. This formula depends on Node and installs the published npm package
# into libexec, then symlinks its `cryptocadet` launcher — the SAME artifact npm and the curl
# installer use, so behavior is identical across macOS and Linux (and Windows via npm/install.ps1).
# This replaces the old pkg-compiled binary approach (per-platform, V8-bytecode-fragile, no
# Windows path).
#
# Source of truth lives here; on release copy to the tap:
#   thetechjd/homebrew-cryptocadet-cli/Formula/cryptocadet.rb
#   => brew install thetechjd/cryptocadet-cli/cryptocadet
#
# REQUIRES the package published to npm (url is the registry tarball). Until then, use the curl
# installer or `npm i -g github:thetechjd/cryptocadet-cli`. On each release bump the url's
# version segment and `sha256` — the SHA-256 of the tarball (NOT npm's `dist.shasum`, which is
# SHA-1):  curl -fsSL https://registry.npmjs.org/@cryptocadet/cli/-/cli-<version>.tgz | shasum -a 256
class Cryptocadet < Formula
  desc "USDC payment rails for agents on Base"
  homepage "https://cryptocadet.app"
  url "https://registry.npmjs.org/@cryptocadet/cli/-/cli-0.1.4.tgz"
  sha256 "c7f3fbcc77470e7df9064c9ebcf175e7c926311f0c9083635abc76408d130a08"
  license :cannot_represent # package is UNLICENSED; update when a license is chosen

  depends_on "node"

  def install
    # Installs the package + production deps (including the optional native keychain
    # @napi-rs/keyring, fetched prebuilt) into libexec, then links the bin. No build step —
    # the published tarball already ships dist/. std_npm_args installs into libexec.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Unknown verb prints the verb list and exits non-zero — proves the JS launcher runs under node.
    assert_match "verbs:", shell_output("#{bin}/cryptocadet nonexistent-verb 2>&1", 1)
  end
end
