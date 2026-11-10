#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Build build/<publisher>.<name>-<version>.vsix from the paths below, less what .vscodeignore leaves out.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$root/shared/build/pack-vsix.js" "$root" package.json extension.js src images README.md
