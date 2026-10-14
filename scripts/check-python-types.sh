#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../clients/python"
UV_PROJECT_ENVIRONMENT=.venv-py39 uv run --python 3.9 --locked --extra dev mypy src/
