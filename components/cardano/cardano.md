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
