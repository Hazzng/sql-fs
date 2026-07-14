#!/usr/bin/env bash
set -euo pipefail
pnpm vitest run src/api/tests/integration/migrations.integration.test.ts --reporter=dot
