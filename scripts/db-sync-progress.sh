#!/usr/bin/env bash
set -euo pipefail

kubectl -n cardano exec cardano-db-1 -c postgres -- \
    psql -U postgres -d cardano -c "
        SELECT
            max(block_no) AS latest_block,
            100 * (EXTRACT(epoch FROM (MAX(time) AT TIME ZONE 'UTC'))
                 - EXTRACT(epoch FROM (MIN(time) AT TIME ZONE 'UTC')))
                / (EXTRACT(epoch FROM (NOW() AT TIME ZONE 'UTC'))
                 - EXTRACT(epoch FROM (MIN(time) AT TIME ZONE 'UTC'))) AS sync_percent
        FROM block;"
