# Midnight Node

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Homepage      | https://midnight.network/                                       |
| Source code   | https://github.com/midnightntwrk/midnight-node                  |
| Documentation | https://docs.midnight.network/nodes/full-node                   |
| Releases      | https://github.com/midnightntwrk/midnight-node/releases/latest  |
| Endpoints     | `endpoints.cluster.midnight-node` (RPC) and `midnight-node-p2p` |

A Midnight full node. `midnight-node:network` selects the network; this stack
defaults to `preprod`. It follows Cardano through the DB Sync PostgreSQL
database and exposes a cluster-only JSON-RPC endpoint on port 9944.

## Prerequisites

- [Cardano node + DB Sync](../cardano/cardano.md) fully synced.
- `midnight-node:network` matches `cardano:network`.
- `midnight-node:nodeName` is unique on the network.

## Storage and resources

The node writes its database to `/node` on a dynamic `250Gi` Longhorn volume
(`longhorn-large`, one replica). The volume survives `pulumi up` and is deleted
by `pulumi destroy`.

The container requests 4Gi and is limited to 16Gi. The ledger database
(`ledger_storage`) is read through the page cache once per imported block, so a
smaller limit causes reclaim and hundreds of major page faults per second.
Midnight's hardware table lists 16 GB; size from that, not from ~2 GiB
anonymous RSS.

## Deployment

Enable only after DB Sync reaches the Cardano tip.

```sh
pulumi config set midnight-node:nodeName <node-name>
pulumi config set midnight-node:enabled true
pulumi up
```

## Configuration

| Key                                      | Default                     | Description                                     |
| ---------------------------------------- | --------------------------- | ----------------------------------------------- |
| `midnight-node:enabled`                  | `false`                     | Deploy the node                                 |
| `midnight-node:image`                    | `.../midnight-node:1.0.400` | Midnight node image                             |
| `midnight-node:network`                  | `preprod`                   | Network preset; must match `cardano:network`    |
| `midnight-node:nodeName`                 | required                    | Human-readable name unique on the network       |
| `midnight-node:bootnodes`                | preprod boot nodes          | Boot node multiaddresses for the target network |
| `midnight-node:cardanoSecurityParameter` | `2160`                      | Cardano security parameter                      |
| `midnight-node:poolLimit`                | `35`                        | Transaction pool limit                          |
| `midnight-node:blockStabilityMargin`     | `10`                        | Chain config value; FNO docs use `30`           |
| `midnight-node:allowNonSsl`              | `true`                      | Allow non-SSL DB connections inside the cluster |
| `midnight-node:validator`                | `false`                     | Validator mode; requires overlay and keys       |
| `midnight-node:reservedNodes`            | unset                       | Reserved peers; required when validator is true |
| `midnight-node:storageSize`              | `250Gi`                     | Node database volume                            |
| `midnight-node:storageClass`             | `longhorn-large`            | One replica storage class                       |
| `midnight-node:fromVolume`               | unset                       | Attach a named volume instead of dynamic        |
| `midnight-node:requiredNodeLabel`        | unset                       | Pin the node to one host                        |
| `midnight-node:requiredVolumeLabel`      | unset                       | Pin an attached named volume to one host        |

## Metrics

The node runs with `--prometheus-external` and serves `/metrics` on port `9615`.
The `midnight-node` Service exposes it as `metrics`, and the
[monitoring setup](../../docs/monitoring.md) scrapes it through the
`midnight-node` ServiceMonitor.

## Verify

```sh
kubectl -n midnight-node logs deploy/midnight-node -f
```

Look for peers and a `best: #` value that increases. `Syncing` means catch-up;
it clears when `best` reaches `target`.

`/health` is reachable on the pod IP: the component runs with `--rpc-cors all`,
which disables Substrate's RPC host filter.

```sh
kubectl -n midnight-node exec deploy/midnight-node -c midnight-node -- \
    curl -s http://localhost:9944/health
```

The deployment probes `/health` for liveness, readiness, and startup. It returns
200 while syncing, so readiness means the RPC is up, not that the node is caught
up. Use `/health/readiness` manually for the caught-up signal.

## Validator mode

`midnight-node:validator: true` adds `--validator`, `--reserved-only`, and the
`midnight-node:reservedNodes` list. It also requires session keys in the node
keystore and the Foundation-provided WireGuard overlay. The overlay addresses,
peer IDs, and reserved peer list are not public; see
[docs/validator.md](../../docs/validator.md).

## Gotchas

- The DB connection string embeds the password. The component URL-encodes
  credentials; for manual strings, encode `/`, `+`, `=` as `%2F`, `%2B`, `%3D`.
  Otherwise the node fails with `failed to lookup address information`.
- The RPC host filter accepts only `localhost:9944` by default. The component
  passes `--rpc-cors all`; the port stays cluster-only and `--rpc-methods safe`
  still applies. A CORS list re-enables the filter and breaks in-cluster clients.
- Deploying before DB Sync is synced logs `No latest block on chain`. Expected.
- The node logs `Skipping token bridge transfer observation` once per imported
  block. The bridge pallet is not configured on the current network; harmless.
- PostgreSQL requires TLS by default. This stack sets `ALLOW_NON_SSL=true` for
  the in-cluster database; production should mount the CNPG CA and set
  `ssl_root_cert`.
- Validator block production starts at epoch `n+2` after registration.
- The image is amd64-only.
