#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential ninja-build ccache python3 xz-utils ca-certificates curl git cmake
if ! swapon --show | grep -q /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 16G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
fi
git ls-remote --heads https://github.com/espressif/llvm-project.git "release/esp_*"
echo "setup done"
nproc
free -h
cmake --version | head -1
g++ --version | head -1
