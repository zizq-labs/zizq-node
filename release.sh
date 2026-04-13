#!/usr/bin/env bash

# Build a release artifact for the Zizq Node client.
#
# Produces:
#   target/release/zizq-<version>.tgz
#   target/release/zizq-<version>.tgz.sha256
#
# Usage:
#   ./release.sh           # build only
#   ./release.sh --check   # verify tests + typecheck pass first

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Read version from package.json.
VERSION="$(node -e 'process.stdout.write(require("./package.json").version)')"
NPM_TARBALL="zizq-labs-zizq-${VERSION}.tgz"
TARBALL="zizq-${VERSION}.tgz"
OUT_DIR="target/release"

echo "==> Zizq Node Client v${VERSION}"

# Optional pre-flight checks.
if [[ "${1:-}" == "--check" ]]; then
    echo "    Running typecheck..."
    npm run typecheck

    echo "    Running tests..."
    npm test
fi

# Compile TypeScript → dist/.
echo "    Compiling..."
npm run build

# Pack the tarball.
echo "    Packing..."
mkdir -p "$OUT_DIR"
npm pack --pack-destination "$OUT_DIR"
mv "${OUT_DIR}/${NPM_TARBALL}" "${OUT_DIR}/${TARBALL}"

# Checksum.
echo "    Computing checksum..."
(cd "$OUT_DIR" && shasum -a 256 "$TARBALL" > "${TARBALL}.sha256")

echo "==> Done."
echo "    ${OUT_DIR}/${TARBALL}"
echo "    ${OUT_DIR}/${TARBALL}.sha256"
