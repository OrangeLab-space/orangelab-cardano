# Cardano Node + DB Sync

|                  |                                                                                |
| ---------------- | ------------------------------------------------------------------------------ |
| Homepage         | https://cardano.org/                                                           |
| Source code      | https://github.com/IntersectMBO/cardano-node                                   |
| Documentation    | https://docs.midnight.network/nodes/cardano-node                               |
| DB Sync source   | https://github.com/IntersectMBO/cardano-db-sync                                |
| DB Sync docs     | https://docs.midnight.network/nodes/cardano-db-sync                            |
| Docker (node)    | https://github.com/IntersectMBO/cardano-node/pkgs/container/cardano-node       |
| Docker (db-sync) | https://github.com/IntersectMBO/cardano-db-sync/pkgs/container/cardano-db-sync |
| Endpoints        | `endpoints.cluster.cardano-p2p`                                                |

A Cardano relay, `cardano-db-sync`, and a CloudNativePG PostgreSQL database.
`cardano:network` selects the network; this stack defaults to `preview`. DB Sync
indexes Cardano into PostgreSQL; the Midnight node reads that database.

## Prerequisites

- Core stack with Longhorn and CloudNativePG.
- `orangelab:coreStackRef` and `orangelab:routingProvider` set.
- Testnet data (preprod reference): Cardano DB ~12 GiB, PostgreSQL ~16 GiB,
  DB Sync ledger ~2 GiB. The node and DB Sync share one 120Gi volume.

## Storage

Dynamic `longhorn-large` (one replica) is the default:

```sh
pulumi config set cardano:storageClass longhorn-large
pulumi config set cardano:postgres/storageClass longhorn-large
pulumi up
```

The `cardano` volume holds both `/data/db` (node) and `/var/lib/cexplorer`
(DB Sync). The class has no disk selector, so a replica may land on another
node's default disk. Use Longhorn node scheduling to exclude it.

For named volumes that survive `pulumi destroy`, see
[Longhorn storage](../../docs/longhorn.md). Do not create `cardano-db`
empty: clone the initialized `cardano-db-1` volume.

## Deployment

This component deploys on every `pulumi up`; it has no `enabled` flag.

```sh
pulumi up
```

DB Sync replays Cardano from genesis; allow several hours. Leave it running
overnight.

## Configuration

| Key                                 | Default                                    | Description                                    |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `cardano:image`                     | `ghcr.io/intersectmbo/cardano-node:11.0.1` | Cardano node image                             |
| `cardano:network`                   | `preview`                                  | Network preset (stack config)                  |
| `cardano:storageSize`               | `120Gi`                                    | Node `/data/db` + DB Sync `/var/lib/cexplorer` |
| `cardano:storageClass`              | `longhorn-large`                           | One replica; dynamic phase only                |
| `cardano:storage/backupEnabled`     | `false`                                    | Backups disabled for reconstructible data      |
| `cardano:fromVolume`                | unset                                      | Attach the static `cardano` volume             |
| `cardano:db-sync/image`             | `.../cardano-db-sync:13.7.1.0`             | DB Sync image                                  |
| `cardano:db/storageSize`            | `50Gi`                                     | PostgreSQL volume                              |
| `cardano:postgres/storageClass`     | `longhorn-large`                           | PostgreSQL storage class                       |
| `cardano:db/image`                  | `.../postgresql:17.11-system-trixie`       | PostgreSQL 17 image                            |
| `cardano:db/resources`              | `1 CPU / 4Gi` request, `4 CPU / 8Gi` limit | PostgreSQL resources                           |
| `cardano:db/postInitApplicationSQL` | grants `cardano` SUPERUSER                 | Mirrors the Midnight DB Sync setup             |
| `cardano:db/fromVolume`             | unset                                      | Attach the cloned PostgreSQL volume            |
| `cardano:requiredNodeLabel`         | unset                                      | Pin node and database to one host              |
| `cardano:requiredVolumeLabel`       | unset                                      | Pin the static `cardano` PV to one host        |
| `cardano:db/requiredVolumeLabel`    | unset                                      | Pin the static DB PV to one host               |

## Why one pod

`cardano-db-sync` connects through a Unix socket, not TCP. The node creates
`/ipc/node.socket`; DB Sync expects `/node-ipc/node.socket`. Both containers run
in one pod and mount one `emptyDir` at both paths. DB Sync waits for the socket.

## Metrics

`cardano-node` binds Prometheus to `127.0.0.1:12798`. A `socat` sidecar
republishes it on pod port `12799`, exposed by the `cardano` Service as
`metrics`. The [monitoring setup](../../docs/monitoring.md) scrapes it through the
`cardano` ServiceMonitor.

A second sidecar runs `cardano-cli query tip` every 15 seconds and serves
`cardano_node_sync_progress_percent` on port `12800`, exposed as
`sync-metrics`. That is the node's network-relative `syncProgress`, not the
local `blockReplayProgress` gauge. The same ServiceMonitor scrapes it.

The pod also declares port `8080` as `db-sync-metrics` so Prometheus can
discover the DB Sync sidecar's native metrics endpoint; the DB Sync PodMonitor
scrapes it through the pod, not the Service.

## Verify

```sh
# Cardano tip; the wrapper derives the network from cardano:network
./scripts/cardano-cli.sh query tip

# DB Sync logs
kubectl -n cardano logs deploy/cardano -c db-sync --tail=100

# DB Sync progress
./scripts/db-sync-progress.sh

# Full evidence capture
./evidence/capture-evidence.sh
```

`syncProgress` near `100.00` means the Cardano node is at the tip. For DB Sync,
compare `latest_block` with the node's `block`. A `sync_percent` near `100` only
means the newest indexed block is recent; it stays high while DB Sync catches
up. Enable Midnight when the heights match.

For a custom testnet, set `CARDANO_NETWORK_MAGIC`.

## Gotchas

- Set the security parameter per network: `432` on preview, `2160` on preprod
  and mainnet. This stack uses `432`.
- DB Sync 13.7.1.0 requires Cardano node 11.0.1 after the Van Rossem change. The
  FNO page's 10.6.2 is stale.
- CNPG defaults are not tuned. The FNO docs recommend `shared_buffers=4GB`;
  testnet-sized data starts fine with defaults. See [RUNBOOK.md](../../RUNBOOK.md).
- The Cardano and DB Sync images are amd64-only.
