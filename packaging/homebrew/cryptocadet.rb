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
# installer or `npm i -g github:thetechjd/cryptocadet-cli`. On each release bump `version`, the
# url's version segment, and `sha256` (the npm tarball shasum:
#   npm view @cryptocadet/cli@<version> dist.shasum ).
class Cryptocadet < Formula
  desc "USDC payment rails for agents on Base"
  homepage "https://cryptocadet.app"
  url "https://registry.npmjs.org/@cryptocadet/cli/-/cli-0.1.3.tgz"
  sha256 "5746b80710203a1c2aa345618efa543e9176f6d1fadb40ee17927c59fea7f299"
  license :cannot_represent # package is UNLICENSED; update when a license is chosen

  depends_on "node"

  def install
    # Installs the package + production deps (including the optional native keychain
    # @napi-rs/keyring, fetched prebuilt) into libexec, then links the bin. No build step —
    # the published tarball already ships dist/.
    system "npm", "install", *std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Unknown verb prints the verb list and exits non-zero — proves the JS launcher runs under node.
    assert_match "verbs:", shell_output("#{bin}/cryptocadet nonexistent-verb 2>&1", 1)
  end
end
