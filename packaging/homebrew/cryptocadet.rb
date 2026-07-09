# Homebrew formula for the CryptoCadet CLI.
#
# This file lives in the CLI repo as the source of truth. On each release, copy it to the tap repo
# at:  thetechjd/homebrew-cryptocadet-cli/Formula/cryptocadet.rb  (a plain repo under thetechjd, no
# GitHub org — same as RDK's homebrew-rdk). Homebrew strips the "homebrew-" prefix, so that repo =>
# tap "thetechjd/cryptocadet-cli" and:
#   brew install thetechjd/cryptocadet-cli/cryptocadet
#
# Filled for v0.1.2 (version + sha256s from dist/bin/SHA256SUMS). At the next release, bump the
# version, each url's vX.Y.Z segment, and each sha256 (the release workflow does this automatically).
# The self-contained binary embeds Node 24 — no node, npm, or node_modules dependency here.
class Cryptocadet < Formula
  desc "USDC payment rails for agents on Base"
  homepage "https://cryptocadet.app"
  version "0.1.2"

  on_macos do
    on_arm do
      url "https://github.com/thetechjd/cryptocadet-cli/releases/download/v0.1.2/cryptocadet-macos-arm64.tar.gz"
      sha256 "a5dce36f30fc0d2e2607c965f1abbc770b1ca5675110b3c15c336ef7ba557eb7"
    end
    on_intel do
      url "https://github.com/thetechjd/cryptocadet-cli/releases/download/v0.1.2/cryptocadet-macos-x64.tar.gz"
      sha256 "521fe15d666bdda54ff8ecf3239e4b3c5cb255b34fff35fecbc4ece72ab84ae4"
    end
  end

  # Optional: uncomment to also serve `brew install` on Linux (binaries already ship). The
  # documented Linux path is the curl installer; Homebrew-on-Linux users can use this instead.
  # on_linux do
  #   on_arm do
  #     url "https://github.com/thetechjd/cryptocadet-cli/releases/download/v0.1.2/cryptocadet-linux-arm64.tar.gz"
  #     sha256 "062c1eae8f667dbef64bf6730382e9ab1b1de9b892862908bd32aa19ad146c58"
  #   end
  #   on_intel do
  #     url "https://github.com/thetechjd/cryptocadet-cli/releases/download/v0.1.2/cryptocadet-linux-x64.tar.gz"
  #     sha256 "98268dba42b302613b41bc731b1c95060cbbf4f9e2261e97c01ebefdaf9d9683"
  #   end
  # end

  def install
    bin.install "cryptocadet"
  end

  test do
    assert_match "cryptocadet", shell_output("#{bin}/cryptocadet 2>&1", 1)
  end
end
