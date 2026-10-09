#!/usr/bin/env bash
# Source the trusted copy inside the agent sandbox; all data stays disposable and local.
chopin_test_databases() {
	local binaries="${1:-/usr/lib/postgresql/17/bin}"
	local directory="${2:-/tmp/gh-aw/postgres}"
	local index name
	"$binaries/postgres" --version | grep -Eq 'PostgreSQL\) 17\.' || return 1
	mkdir -p "$directory"
	if ! "$binaries/pg_ctl" -D "$directory/data" status >/dev/null 2>&1; then
		if [ ! -f "$directory/data/PG_VERSION" ]; then
			"$binaries/initdb" -D "$directory/data" -U chopin -A trust --no-locale \
				--encoding=UTF8 || return 1
		fi
		"$binaries/pg_ctl" -D "$directory/data" -l "$directory/server.log" \
			-o "-h 127.0.0.1 -p 5433 -k $directory" -w start || return 1
	fi
	for index in 0 1 2 3 contract; do
		name="chopin_test_$index"
		if [ "$("$binaries/psql" -h 127.0.0.1 -p 5433 -U chopin -d postgres \
			-Atc "SELECT 1 FROM pg_database WHERE datname = '$name'")" != "1" ]; then
			"$binaries/createdb" -h 127.0.0.1 -p 5433 -U chopin "$name" || return 1
		fi
		if [ "$index" = contract ]; then
			export TEST_DATABASE_URL="postgresql://chopin@127.0.0.1:5433/$name?sslmode=disable"
		else
			printf -v "E2E_DATABASE_URL_$index" '%s' \
				"postgresql://chopin@127.0.0.1:5433/$name?sslmode=disable"
			export "E2E_DATABASE_URL_$index"
		fi
	done
}
chopin_test_databases "$@"
