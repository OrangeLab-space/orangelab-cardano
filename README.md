# Cardano Stack

Cardano and Midnight nodes for the Midnight Foundation Node Operator (FNO)
track. The bundled stack config targets preprod; `cardano:network` and
`midnight-node:network` select the network.

**Prerequisite**: Core stack must be deployed first (network, storage,
`cloudnative-pg`, and the Prometheus Operator/Grafana monitoring stack).

## Components

- [Cardano Node + DB Sync](./components/cardano/cardano.md) — Cardano relay,
  `cardano-db-sync`, and PostgreSQL
- [Midnight Node](./components/midnight-node/midnight-node.md) — Midnight full
  node
- [Midnight Indexer](./components/midnight-indexer/midnight-indexer.md) — GraphQL
  indexer for the Midnight node (optional; requires an archive node)

The full FNO walkthrough, including DB Sync verification and the gated validator
steps, is in [RUNBOOK.md](./RUNBOOK.md).

## Networks

`cardano:network` and `midnight-node:network` select the Cardano and Midnight
network presets and must match. The bundled `Pulumi.yaml` uses `preprod`; set
both keys, and the Midnight bootnodes, when targeting another network.

## Evidence

[`evidence/`](./evidence) holds point-in-time snapshots of the running stack:
Cardano tip, DB Sync block height, Midnight sync line and peer count, pod
restart counts, and recent logs. Each run of `scripts/capture-evidence.sh` writes
a new UTC-stamped directory, so two captures show block progression. Commit them
as-is; they contain no secrets.

## Storage

The simple setup uses dynamic Longhorn volumes with `longhorn-large` (one
replica); no volumes need to be created in advance:

| Volume             | Size  |
| ------------------ | ----- |
| `cardano`          | 120Gi |
| `cardano-db`       | 50Gi  |
| `midnight-node`    | 250Gi |
| `midnight-indexer` | 250Gi |

The single `cardano` volume holds both data trees: the node writes `/data/db`
and DB Sync writes `/var/lib/cexplorer`. The `midnight-node` volume is created
empty when the Midnight node is enabled.

The class has no disk selector, so a dynamic replica may land on another node's
default disk. Exclude unwanted nodes with Longhorn node scheduling.

Dynamic volumes survive `pulumi up` but are deleted by `pulumi destroy`; use
named volumes if the data must outlive the stack. See
[RUNBOOK.md](./RUNBOOK.md#static-volumes) for the clone/redeploy workflow.

## Configure Applications

### Cardano Node + DB Sync

This is the long pole. It has no `enabled` flag; every `pulumi up` deploys it.

```sh
pulumi up
```

DB Sync replays the Cardano chain from genesis; on preprod this takes six hours
or more. Leave it running and verify progress with
`./scripts/db-sync-progress.sh`.

### Midnight Node

Enable only after DB Sync has reached the Cardano tip.

```sh
pulumi config set midnight-node:nodeName <node-name>
pulumi config set midnight-node:enabled true
pulumi up
```

See the [Midnight node docs](./components/midnight-node/midnight-node.md) for
the optional validator settings.

## Monitoring

`pulumi up` installs Prometheus ServiceMonitors, alert rules, and a Grafana
dashboard for the Cardano and Midnight nodes. Metrics and alert definitions live
in the [monitoring component](./components/monitoring); see
[`components/monitoring/README.md`](./components/monitoring/README.md) for the
manifests, verification commands, and operational responses.

The alerts are deliberately outcome-based rather than CPU/memory-based:

| Alert                     | Why it matters                                                         | Response                                                                  |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CardanoTipStalled`       | A node not receiving blocks cannot feed DB Sync.                       | Check node logs, peers, disk, and DB Sync before restarting.              |
| `MidnightBlockStalled`    | The Midnight node is not importing blocks.                             | Check the database connection, RPC, peers, and node logs.                 |
| `MidnightPeersLow`        | Low peers risk a sync stall and isolate the node.                      | Check bootnodes, network reachability, and firewall rules.                |
| `NodeContainerRestarting` | Restarts can indicate OOM, bad configuration, or a failing dependency. | Inspect previous logs and exit code; treat repeated restarts as critical. |

CPU and memory are on the dashboard for diagnosis, but they are not paging
alerts: Midnight memory is dominated by reclaimable page cache, and CPU bursts
during sync are normal. This is a full node, not a validator, so validator-only
block-production alerts are out of scope until validator mode is enabled.

## Automation Scripts (Section 3)

All three Section 3 options are implemented under [`scripts/`](./scripts):
key collection (A), maintenance notification (B), and the node health checker
(C). They use only the Python standard library, and mock fixtures make each flow
runnable offline. See [`scripts/README.md`](./scripts/README.md) for detailed
usage, options, output formats, and exit codes.

## Sizing

The data footprint depends on the network. On preprod, the Cardano node is about
12 GiB, DB Sync PostgreSQL about 16 GiB, and DB Sync ledger state about 2 GiB.
The defaults here allocate a 120 GiB shared Cardano volume, 50 GiB for
PostgreSQL, and a 250 GiB Midnight node volume. The optional Midnight indexer
adds its own 250 GiB volume; it re-indexes from genesis, so it can be recreated
at any time.

The FNO minimum is 8 cores, 32 GiB RAM, 500 GiB NVMe, and 20,000 IOPS. A 16-core
/ 64 GiB / 1 TiB machine is comfortable.

## Gotchas

- **Empty static DB volume**: CloudNativePG skips `initdb` on an existing but
  uninitialized `cardano-db` volume, and the PostgreSQL container fails on
  `pgdata`. Clone the initialized `cardano-db-1` volume instead of creating it
  empty. See [RUNBOOK.md](./RUNBOOK.md#static-volumes).
