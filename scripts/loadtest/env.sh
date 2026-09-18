# Shared configuration for the load-test harness.
#
# Sourced by up.sh / down.sh. You do NOT need to source it to run a scenario — the scenarios read
# the same defaults themselves. Source it only to override something, or to use lt_pg_url.
#
# No `set -e` and no exported functions here on purpose: this file gets sourced into interactive
# shells (bash and zsh), and neither travels well.

# Portable "directory of this file", for both `bash up.sh` and a zsh `source`.
if [ -n "${BASH_SOURCE:-}" ]; then
	_lt_self="${BASH_SOURCE[0]}"
else
	_lt_self="$0"
fi
: "${LT_DIR:=$(cd "$(dirname "$_lt_self")" && pwd)}"
unset _lt_self
export LT_DIR
export LT_RUN="${LT_RUN:-$LT_DIR/.run}"

export LT_PGUSER="${LT_PGUSER:-sqlfs_app}"
export LT_PGPASS="${LT_PGPASS:-sqlfs_app}"
export LT_PGHOST="${LT_PGHOST:-127.0.0.1}"
export LT_PGPORT="${LT_PGPORT:-5432}"

# Two replicas, ONE database, ONE Redis. That pairing is what makes the cross-replica bugs
# reachable — on a single replica the in-process session lock masks them.
export LT_DB_SHARED="${LT_DB_SHARED:-lt_shared}"
export LT_REDIS_SHARED="${LT_REDIS_SHARED:-redis://127.0.0.1:6379/9}"
export LT_REPLICA_A="${LT_REPLICA_A:-8101}"
export LT_REPLICA_B="${LT_REPLICA_B:-8102}"

# Isolated replica with its own Redis, for stalls, maxmemory pressure and kills.
export LT_DB_FAULT="${LT_DB_FAULT:-lt_fault}"
export LT_REDIS_FAULT="${LT_REDIS_FAULT:-redis://127.0.0.1:6380}"
export LT_REPLICA_FAULT="${LT_REPLICA_FAULT:-8103}"

export LT_AUTH_SECRET="${LT_AUTH_SECRET:-loadtest-secret-at-least-32-bytes-long-xxxxx}"
export LT_OWNER="${LT_OWNER:-loadtest-owner}"

lt_pg_url() { echo "postgres://${LT_PGUSER}:${LT_PGPASS}@${LT_PGHOST}:${LT_PGPORT}/$1"; }
