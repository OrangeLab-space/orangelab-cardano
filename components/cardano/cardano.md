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

A Cardano relay node, `cardano-db-sync`, and a CloudNativePG PostgreSQL
database. The network is selected by `cardano:network`; this stack defaults to
`preprod`. DB Sync indexes the Cardano chain into PostgreSQL; the Midnight node
reads that database.

## Prerequisites

- Core stack with Longhorn and CloudNativePG deployed.
- `orangelab:coreStackRef` and `orangelab:routingProvider` set for the stack.
- About 12 GiB for the Cardano node database, 50 GiB for PostgreSQL, and 2 GiB
  for DB Sync's ledger state on preprod. The node and DB Sync share one 120Gi
  volume; actual usage depends on the network and is lower than the allocation.

## Storage

Start with the Cardano and PostgreSQL volumes dynamic using `longhorn-large`
(one replica). The class has no disk selector, so a dynamic replica may land on
another node's default disk. Clones inherit the source placement; move the
dynamic volume to the `cardano` disk first if needed, or move the clone
afterwards.

```sh
pulumi config set cardano:storageClass longhorn-large
pulumi config set cardano:postgres/storageClass longhorn-large
pulumi up
```

The single `cardano` volume is 120Gi and holds both data trees: the node writes
`/data/db`, DB Sync writes `/var/lib/cexplorer`. The DB image and wrapper paths
do not change; the volume is mounted at both paths.

Once the DB and pods are healthy, keep the DB cluster while stopping the
cardano deployment, then hibernate the DB so its volume detaches:

```sh
pulumi config set cardano:db/enabled true
pulumi config set cardano:storageOnly true
pulumi up
kubectl annotate cluster cardano-db -n cardano cnpg.io/hibernation=on

# The VOLUME column is the Longhorn volume name (pvc-...).
kubectl get pvc -n cardano -o wide
```

Clone the dynamic `cardano` volume to `cardano` and the dynamic `cardano-db-1`
volume to `cardano-db`. Use **1 replica**, **Block Device** frontend, **v1**
data engine, **ReadWriteOnce** access mode, and the `cardano` disk selector. Do
not create `cardano-db` empty; clone the initialized CNPG volume.

Attach the named volumes:

```sh
pulumi config set cardano:fromVolume cardano
pulumi config set cardano:db/fromVolume cardano-db
pulumi config set cardano:requiredNodeLabel kubernetes.io/hostname=<node>
pulumi config set cardano:requiredVolumeLabel kubernetes.io/hostname=<node>
pulumi config set cardano:db/requiredVolumeLabel kubernetes.io/hostname=<node>
kubectl annotate cluster cardano-db -n cardano cnpg.io/hibernation-
pulumi config delete cardano:storageOnly
pulumi up
```

The `storageClass` settings are ignored once `fromVolume` is set.

## Deployment

This component is deployed by every `pulumi up`; it has no `enabled` flag.

```sh
pulumi up
```

This starts the long pole: DB Sync must replay the Cardano chain from genesis,
which takes six hours or more on preprod. Leave it running overnight.

## Configuration

| Key                                 | Default                                    | Description                                    |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `cardano:image`                     | `ghcr.io/intersectmbo/cardano-node:11.0.1` | Cardano node image                             |
| `cardano:network`                   | `preprod`                                  | Cardano network preset (stack config)          |
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
| `cardano:requiredNodeLabel`         | unset                                      | Pin the node and database to one host          |
| `cardano:requiredVolumeLabel`       | unset                                      | Pin the static `cardano` PV to one host        |
| `cardano:db/requiredVolumeLabel`    | unset                                      | Pin the static DB PV to one host               |

## Why one pod

`cardano-db-sync` connects to `cardano-node` through a Unix socket, not TCP. The
node creates `/ipc/node.socket`; the DB Sync image expects
`/node-ipc/node.socket`. Both containers run in the same pod and mount one
`emptyDir` at those two paths. The DB Sync sidecar waits for the socket before
starting.

## Metrics

`cardano-node` binds its Prometheus endpoint to `127.0.0.1:12798`. A `socat`
sidecar republishes it on pod port `12799`, exposed by the `cardano` Service as
`metrics`. The [monitoring setup](../monitoring/README.md) scrapes it through
the `cardano` ServiceMonitor.

## Verify

```sh
# Cardano tip (the wrapper derives the network from cardano:network)
./scripts/cardano-cli.sh query tip

# DB Sync logs
kubectl -n cardano logs deploy/cardano -c db-sync --tail=100

# DB Sync progress
./scripts/db-sync-progress.sh

# Full evidence capture
./scripts/capture-evidence.sh
```

The `cardano-cli` wrapper derives the network flag from `cardano:network`; for a
custom testnet, set `CARDANO_NETWORK_MAGIC`.

`syncProgress` near `100.00` means the Cardano node is at the tip. For DB Sync,
compare `latest_block` with the node's `block` — a `sync_percent` near `100` only
means the newest indexed block is recent, so it stays high while DB Sync is still
catching up. Enable the Midnight node once the heights match.

## Gotchas

- Set the Cardano security parameter per network: `2160` on preprod, `432` on
  preview. The FNO runbook's `432` is the Preview value; this stack uses `2160`.
- DB Sync 13.7.1.0 requires Cardano node 11.0.1 after the Van Rossem change.
  The FNO page's 10.6.2 is stale.
- CNPG defaults are not tuned. The FNO docs recommend `shared_buffers=4GB`;
  preprod-sized data starts fine with the defaults, but tune it if sync is slow.
  See [RUNBOOK.md](../../RUNBOOK.md).
- The Cardano node and DB Sync images are amd64-only.
