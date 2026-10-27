# Cardano Stack

Cardano relay + DB Sync + PostgreSQL, a Midnight full node, and an optional
Midnight indexer. Pulumi TypeScript on the OrangeLab library.

`cardano:network` and `midnight-node:network` must match. The stack defaults to
`preprod`; the docs stay network-agnostic.

**Prerequisite:** OrangeLab core stack with Longhorn, CloudNativePG, and the
Prometheus Operator/Grafana stack.

## Components

| Component                                                             | Purpose                                            |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| [Cardano + DB Sync](./components/cardano/cardano.md)                  | Cardano relay, DB Sync, and PostgreSQL             |
| [Midnight Node](./components/midnight-node/midnight-node.md)          | Midnight full node                                 |
| [Midnight Indexer](./components/midnight-indexer/midnight-indexer.md) | Optional GraphQL indexer; requires archive pruning |

## Quick start

```sh
pulumi stack init lab-cardano
pulumi config set orangelab:coreStackRef <core-stack-ref>
pulumi config set orangelab:routingProvider traefik  # or tailscale
# Generate the DB password once; keep it stable across restores.
pulumi config set --secret cardano:db/password "$(openssl rand -hex 32)"
pulumi up
```

DB Sync replays Cardano from genesis; on preprod this takes six hours or more.

```sh
./scripts/cardano-cli.sh query tip
./scripts/db-sync-progress.sh
```

Enable Midnight only when DB Sync matches the Cardano tip:

```sh
pulumi config set midnight-node:nodeName <node-name>
pulumi config set midnight-node:enabled true
pulumi up
```

Full deployment sequence and troubleshooting: [RUNBOOK.md](./RUNBOOK.md).
Storage details: [docs/longhorn.md](./docs/longhorn.md). Validator mode:
[docs/validator.md](./docs/validator.md).

## Storage

The default is dynamic Longhorn (`longhorn-large`, one replica):

| Volume             | Size  |
| ------------------ | ----- |
| `cardano`          | 120Gi |
| `cardano-db`       | 50Gi  |
| `midnight-node`    | 250Gi |
| `midnight-indexer` | 250Gi |

`pulumi destroy` deletes dynamic volumes. For named volumes that survive
destroy, see [Longhorn storage](./docs/longhorn.md).

## Monitoring (Section 2)

All monitoring assets live in [components/monitoring](./components/monitoring).
`pulumi up` installs the ServiceMonitors, Prometheus rules, and Grafana
dashboard.

| Alert                     | Signal                                       | Response                                                             |
| ------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `CardanoTipStalled`       | Tip unchanged for 15 minutes                 | Check logs, peers, disk, and DB Sync. Do not restart blindly.        |
| `MidnightBlockStalled`    | Best block unchanged for 15 minutes          | Check the database, RPC, peers, and node logs.                       |
| `MidnightPeersLow`        | Peer count below 3 for 10 minutes            | Check bootnodes, network reachability, and firewall rules.           |
| `NodeContainerRestarting` | Any container restart in the last 15 minutes | Inspect previous logs and exit code; repeated restarts are critical. |

The alerts are outcome-based. CPU and memory are dashboard signals, not pages:
sync bursts are normal and Midnight memory is mostly reclaimable page cache.
This is a full node, so validator-only alerts stay out of scope.

Details and verification commands:
[components/monitoring/README.md](./components/monitoring/README.md).

## Automation scripts (Section 3)

All three options are implemented in Python 3 using only the standard library.

| Script                                                                           | Option | Purpose                                                       |
| -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| [`collect-fno-keys.py`](./scripts/collect-fno-keys.py)                           | A      | Collect FNO public keys; report responders and non-responders |
| [`send-maintenance-notification.py`](./scripts/send-maintenance-notification.py) | B      | Send or dry-run a maintenance window; flag missing acks       |
| [`node-health-check.py`](./scripts/node-health-check.py)                         | C      | Poll metrics, write a health report, and diff regressions     |

Usage, options, outputs, and exit codes:
[scripts/README.md](./scripts/README.md).

## Security (Section 4)

Key storage, rotation, and incident response:
[SECURITY.md](./SECURITY.md). The default is a full node; session-key controls
apply when `midnight-node:validator` is true.

## Evidence (Section 1)

Captures, capture script, and evidence notes live in
[`evidence/`](./evidence). See [evidence/README.md](./evidence/README.md) for
the captured heights and file list. The folder is self-contained and can be
included or omitted as a unit.

## Infrastructure as Code

This stack uses Pulumi, not Terraform. The Section 5 equivalents are:

- **Modules:** `components/cardano`, `midnight-node`, `midnight-indexer`, and
  `monitoring`.
- **Environments:** `Pulumi.yaml` defaults plus stack config; network keys select
  the target.
- **State:** the Pulumi backend; use a remote backend with locking for shared
  environments.
- **Dependencies:** `index.ts` wires Cardano → Midnight → optional indexer; DB
  Sync waits on the node socket.
- **Checks:** `npm test` (typecheck only) and `pulumi preview --diff`.
- **Deploy:** `pulumi up`; teardown: `pulumi destroy`.

## Assumptions

- One Kubernetes cluster with the OrangeLab core stack already deployed.
- Dynamic Longhorn storage is acceptable; there is no HA.
- The stack runs a full node. Validator keys and the WireGuard overlay are gated.
- Preprod is the default; other networks need matching config and bootnodes.
- Lab secrets live in Pulumi state; production uses external secret management.

## Trade-offs and next steps

- DB Sync replays from genesis; Mithril would shorten rebuilds.
- DB Sync has no native metrics endpoint, so it is not alerted.
- One Longhorn replica, no HA; images are amd64-only.
- Section 5 uses Pulumi rather than Terraform; no GitHub Actions workflow is
  committed.
- Production hardening: external secrets, encrypted disks, non-root containers,
  backups, and HA. See [SECURITY.md](./SECURITY.md).
