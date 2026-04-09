#!/usr/bin/env bash
# Cross-compile the Fenris Windows agent for amd64 and arm64.
# Run from any Linux/macOS machine with Go 1.22+ installed.
set -euo pipefail

BINARY_NAME="fenris-agent"
OUTPUT_DIR="dist"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo 'dev')}"

mkdir -p "$OUTPUT_DIR"

LDFLAGS="-s -w -X main.version=${VERSION}"

echo "Building Fenris Windows Agent ${VERSION}..."

echo "  → windows/amd64"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="$LDFLAGS" -o "${OUTPUT_DIR}/${BINARY_NAME}-windows-amd64.exe" .

echo "  → windows/arm64"
GOOS=windows GOARCH=arm64 CGO_ENABLED=0 \
  go build -ldflags="$LDFLAGS" -o "${OUTPUT_DIR}/${BINARY_NAME}-windows-arm64.exe" .

echo ""
echo "Artifacts:"
ls -lh "${OUTPUT_DIR}/"*.exe
