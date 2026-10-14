#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../clients/python"
uv run --locked --extra dev ruff format --check .
uv run --locked --extra dev ruff check .
bash ../../scripts/check-python-types.sh
uv run --locked --extra dev pytest
