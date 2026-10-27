# Midnight Node

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Homepage      | https://midnight.network/                                       |
| Source code   | https://github.com/midnightntwrk/midnight-node                  |
| Documentation | https://docs.midnight.network/nodes/full-node                   |
| Releases      | https://github.com/midnightntwrk/midnight-node/releases/latest  |
| Endpoints     | `endpoints.cluster.midnight-node` (RPC) and `midnight-node-p2p` |

A Midnight full node. The network is selected by `midnight-node:network`; this
stack defaults to `preprod`. It follows Cardano through the `cardano-db-sync`
PostgreSQL database and exposes a cluster-only JSON-RPC endpoint on port 9944.

## Prerequisites

- [Cardano node + DB Sync](../cardano/cardano.md) fully synced.
- `midnight-node:network` set to the same network as `cardano:network`.
- `midnight-node:nodeName` set to a name unique on the network.

## Storage

The node uses the static `midnight-node` Longhorn volume, created with the
other Cardano volumes in the Longhorn UI (250Gi, 1 replica, Block Device, v1,
ReadWriteOnce, `cardano` disk selector). Before enabling it, set the volume and
node pinning:

```sh
pulumi config set midnight-node:fromVolume midnight-node
pulumi config set midnight-node:requiredVolumeLabel kubernetes.io/hostname=<node>
```

If the volume uses `strict-local` data locality, its `nodeID` must be the same
node as the static PV. A `strict-local` volume pinned to another node has an
unschedulable replica, and the pod stays in `FailedAttachVolume` with
`volume ... detached state with some un-schedulable replicas`.

## Resources

The container requests 4Gi and is limited to 16Gi. The ledger database
(`ledger_storage`) is read through the page cache once per imported block, so a
smaller limit makes the kernel reclaim and re-read it, producing hundreds of
major page faults per second. Midnight's own hardware table lists 16 GB for a
node; size from that, not from the ~2 GiB anonymous RSS.

## Deployment

Enable only after DB Sync has reached the Cardano tip.

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
| `midnight-node:cardanoSecurityParameter` | `2160`                      | Cardano security parameter (preprod: `2160`)    |
| `midnight-node:poolLimit`                | `35`                        | Transaction pool limit                          |
| `midnight-node:blockStabilityMargin`     | `10`                        | Network chain config value; FNO docs use `30`   |
| `midnight-node:allowNonSsl`              | `true`                      | Allow non-SSL DB connections inside the cluster |
| `midnight-node:validator`                | `false`                     | Validator mode; requires overlay and keys       |
| `midnight-node:reservedNodes`            | unset                       | Reserved peers; required when validator is true |
| `midnight-node:storageSize`              | `250Gi`                     | Node database volume                            |
| `midnight-node:storageClass`             | `longhorn-large`            | One replica storage class                       |
| `midnight-node:fromVolume`               | `midnight-node`             | Attach the static Longhorn volume               |
| `midnight-node:requiredNodeLabel`        | unset                       | Pin the node to one host                        |
| `midnight-node:requiredVolumeLabel`      | unset                       | Pin the static PV to one host                   |

## Verify

```sh
kubectl -n midnight-node logs deploy/midnight-node -f
```

Look for the peer count and a `best: #` value that increases. While the node is
catching up the sync line starts with `Syncing`; it clears when `best` reaches
`target`. Epoch and committee lines appear as sessions rotate.

The `/health` endpoint is **localhost-only**: it returns HTTP 200 from inside
the container but HTTP 403 to the kubelet's pod-IP request. The deployment
therefore has no HTTP probes. Check it from inside the pod:

```sh
kubectl -n midnight-node exec deploy/midnight-node -c midnight-node -- \
    curl -s http://localhost:9944/health
```

Do not add an HTTP liveness/readiness probe for `/health`; it will crash-loop
the pod on the first probe failure.

## Validator mode

`midnight-node:validator: true` adds `--validator`, `--reserved-only`, and the
`midnight-node:reservedNodes` list. It also requires session keys in the node's
keystore and the Foundation-provided WireGuard overlay. The overlay addresses,
peer IDs, and reserved peer list are not public; see
[RUNBOOK.md](../../RUNBOOK.md#fno-validator-mode).

## Gotchas

- The DB connection string embeds the generated password. Credentials are
  URL-encoded by the component; if you build a connection string manually,
  encode reserved characters (`/`, `+`, `=`) as `%2F`, `%2B`, `%3D`. Otherwise
  the parser treats the `/` as the end of the URL authority and the node fails
  with `failed to lookup address information: Name or service not known`.
- The `/health` endpoint is localhost-only. Kubernetes HTTP probes receive 403
  from the pod IP, so the deployment omits probes. Verify health with
  `kubectl exec ... curl localhost:9944/health`.
- The RPC host filter only accepts `localhost:9944` by default, so other pods
  cannot reach it. The component passes `--rpc-cors all` to allow in-cluster
  clients; the port stays cluster-only and `--rpc-methods safe` still applies.
- A `strict-local` Longhorn volume must be pinned to the same node as the PV.
  Re-pin its `nodeID` if the replica is unschedulable.
- Deploying before DB Sync is synced leaves the node waiting. It logs
  `No latest block on chain`; this is expected.
- The node logs `Skipping token bridge transfer observation. Pallet not
configured.` once per imported block. The cardano-to-midnight bridge pallet is
  not configured on the current network, so the inherent data provider is inert.
  Harmless; the rate drops to one line per block time at the tip.
- PostgreSQL connections require TLS by default. This stack sets
  `ALLOW_NON_SSL=true` for the in-cluster database; for production, mount the
  CNPG CA and set `ssl_root_cert` instead.
- Validator block production starts at epoch `n+2` after registration.
- The image is amd64-only.
