#!/usr/bin/env bash
# Ubuntu 24.04. Run as the sudo-enabled administrator, not as the service user.
set -euo pipefail
node_version=24.19.0
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) printf 'Unsupported architecture\n' >&2; exit 1 ;;
esac
node_stage=$(mktemp -d)
trap 'rm -rf "$node_stage"' EXIT
cd "$node_stage"
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 -O "https://nodejs.org/dist/v${node_version}/${node_archive}"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 -O "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
awk -v file="$node_archive" '$2==file {print; found=1} END {if (!found) exit 1}' SHASUMS256.txt > selected.sha256
sha256sum --check selected.sha256
sudo tar -xJf "$node_archive" --strip-components=1 -C /usr/local
/usr/local/bin/node --version
/usr/local/bin/npm --version
