#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
mkdir -p artifacts
tar -czf artifacts/zuno-release.tgz dist package.json package-lock.json deploy scripts/backup.mjs .env.example README.md docs
sha256sum artifacts/zuno-release.tgz > artifacts/zuno-release.tgz.sha256
printf 'Release: artifacts/zuno-release.tgz\n'
