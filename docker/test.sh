#!/usr/bin/env bash
# Build the docker image and run the extension's tests inside it.
#   ./docker/test.sh            # typecheck + unit + integration + package
#   ./docker/test.sh unit       # fast loop
#   ./docker/test.sh integration
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=laxative-test

docker build -f "$ROOT/docker/Dockerfile" -t "$IMAGE" "$ROOT"
docker volume create laxative-vscode-cache >/dev/null

mkdir -p "$ROOT/dist"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$ROOT:/src:ro" \
  -v "$ROOT/dist:/out" \
  -v laxative-vscode-cache:/cache \
  "$IMAGE" "${@:-all}"
