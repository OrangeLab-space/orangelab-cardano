# Midnight Indexer

|               |                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------ |
| Homepage      | https://midnight.network/                                                                  |
| Source code   | https://github.com/midnightntwrk/midnight-indexer                                          |
| Documentation | https://docs.midnight.network/relnotes/midnight-indexer                                    |
| Configuration | https://github.com/midnightntwrk/midnight-indexer/blob/main/indexer-standalone/config.yaml |
| Docker Image  | https://hub.docker.com/r/midnightntwrk/indexer-standalone                                  |
| Endpoints     | `endpoints.cluster.midnight-indexer` (GraphQL at `/api/v4/graphql`)                        |

A GraphQL indexer over the Midnight chain, for applications that query blocks,
transactions and contract state. It follows the
[Midnight node](../midnight-node/midnight-node.md) RPC endpoint and stores its
data in SQLite on its own volume.

The image is the upstream `indexer-standalone` build: chain indexer, API, wallet
indexer and SPO indexer in one process. The split deployment (separate
components, PostgreSQL, NATS) is not modelled here.

## Prerequisites

- [Midnight node](../midnight-node/midnight-node.md) enabled.
- The node must run with **archive state pruning** (`--state-pruning archive`).
  The indexer starts at genesis and needs the runtime state at every height. A
  node with the default `--state-pruning 256` fails with `UnknownBlock` and the
  indexer restarts; the node reports `State already discarded`. Pruning mode is
  fixed when the node database is created, so converting an existing node means
  resyncing from genesis into a much larger volume.

The FNO node in this stack is pruned, so the indexer is disabled by default and
`midnight-indexer:enabled true` against it will crash-loop until the node is
rebuilt as an archive node.

## Deployment

`midnight-indexer:secret` encrypts sensitive wallet data in the indexer database.
Set it once and keep it with the stack — a new value makes the stored data
unreadable:

```sh
pulumi config set midnight-indexer:secret "$(openssl rand -hex 32)" --secret
pulumi config set midnight-indexer:enabled true
pulumi up
```

The indexer inherits the node's network and RPC endpoint; there is no separate
network setting.

## Storage

One dynamic `250Gi` Longhorn volume (`longhorn-large`) holds `/data`:
`indexer.sqlite` for the chain data and `ledger-db.sqlite` for the ledger state.
The data is reconstructible, so the volume can be deleted and recreated. The
indexer indexes from genesis, so it starts at height 0 on a fresh volume and
trails the node until it catches up.

## Resources

The container requests 500m CPU / 1Gi and is limited to 2 CPU / 4Gi. It keeps a
ledger cache and a 512MiB contract-state cache, so size from measured RSS rather
than from an idle pod.

## Configuration

| Key                                    | Default                                    | Description                                |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `midnight-indexer:enabled`             | `false`                                    | Deploy the indexer                         |
| `midnight-indexer:image`               | `midnightntwrk/indexer-standalone:4.3.800` | Indexer image                              |
| `midnight-indexer:secret`              | required                                   | Encrypts stored wallet data                |
| `midnight-indexer:blockfrostId`        | unset                                      | Blockfrost project id, SPO stake data only |
| `midnight-indexer:storageSize`         | `250Gi`                                    | Volume for `/data`                         |
| `midnight-indexer:storageClass`        | `longhorn-large`                           | One replica storage class                  |
| `midnight-indexer:fromVolume`          | unset                                      | Attach a named volume instead of dynamic   |
| `midnight-indexer:requiredNodeLabel`   | unset                                      | Pin the pod to one host                    |
| `midnight-indexer:requiredVolumeLabel` | unset                                      | Pin an attached named volume to one host   |

## Verify

```sh
kubectl -n midnight-indexer logs deploy/midnight-indexer -f
kubectl -n midnight-indexer port-forward deploy/midnight-indexer 8088:8088
```

Query the latest indexed block:

```sh
curl -s http://localhost:8088/api/v4/graphql \
    -H 'content-type: application/json' \
    -d '{"query":"{ block { height } }"}'
```

The height climbs towards the node's `best: #` value. Subscriptions use the same
path with a WebSocket upgrade, `/api/v4/graphql/ws`.

## Gotchas

- The image runs as uid 10001. The component chowns `/data` with an init
  container; without that the indexer cannot create its SQLite database and
  exits.
- The standalone binary always starts the SPO indexer, which requires a
  Blockfrost id. Without a real id it logs Blockfrost errors on each stake
  refresh and SPO stake data stays empty; chain indexing is unaffected. Set
  `midnight-indexer:blockfrostId` with `--secret` to keep the project id out of
  the plaintext stack config.
- The GraphQL API is cluster-only. Use `kubectl port-forward` or an in-cluster
  client; do not expose it publicly.
- SQLite serialises ledger-backed queries on one connection, so concurrent
  GraphQL queries queue behind each other. This is fine for a single operator,
  but the PostgreSQL cloud mode is the scale-out path.
