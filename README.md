# Cardano Stack

## Prerequisites

Kubernetes cluster has to be provisioned, see https://github.com/OrangeLab-space/orange-lab

Required components:

- K3S (`./scripts/k3s-server.sh` and `./scripts/k3s-agent.sh`)
- Tailscale/Headscale for node-to-node communication and access to private endpoints
- Longhorn storage (`longhorn:enabled=true`)
- Prometheus monitoring (`prometheus:enabled=true`)

## Components

| Component                                                             | Purpose                                            |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| [Cardano + DB Sync](./components/cardano/cardano.md)                  | Cardano relay, DB Sync, and PostgreSQL             |
| [Midnight Node](./components/midnight-node/midnight-node.md)          | Midnight full node                                 |
| [Midnight Indexer](./components/midnight-indexer/midnight-indexer.md) | Optional GraphQL indexer; requires archive pruning |

## Quick start

```sh
# Initialize Pulumi stack
pulumi stack init lab-cardano

# Set required stack-level configuration
pulumi config set orangelab:coreStackRef <core-stack-ref> # organization/orangelab/lab
pulumi config set orangelab:routingProvider traefik  # or tailscale

# Generate the DB password once; keep it stable across restores.
pulumi config set --secret cardano:db/password "$(openssl rand -hex 32)"

# Deploy stack (Cardano node and DB Sync enabled by default)
pulumi up
```

This will deploy Cardano node and DB Sync sidecar.
Once sync is completed, enable Midnight:

```sh
pulumi config set midnight-node:nodeName <node-name>
pulumi config set midnight-node:enabled true
pulumi up
```

Full deployment sequence and troubleshooting: [RUNBOOK.md](./RUNBOOK.md).
Storage details: [docs/longhorn.md](./docs/longhorn.md).

## Logs

Artifacts from the last sync run:

- [`sync-cardano.json`](./docs/sync-cardano.json) — Cardano tip and sync progress
- [`sync-db.log`](./docs/sync-db.log) — DB Sync logs
- [`sync-midnight-node.log`](./docs/sync-midnight-node.log) — Midnight node logs

## Monitoring

You can use Grafana dashboard (_Cardano + Midnight_) or below commands to monitor progress.

```sh
./scripts/cardano-cli.sh query tip
./scripts/db-sync-progress.sh
```

Monitoring components (alerts, dashboards) in [components/monitoring](./components/monitoring).
`pulumi up` installs the ServiceMonitors, PodMonitors, Prometheus rules, and
Grafana dashboard. The dashboard is grouped into Cardano, DB Sync, Midnight, and
resource sections.

| Alert                     | Signal                                       | Response                                                             |
| ------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `CardanoTipStalled`       | Tip unchanged for 15 minutes                 | Check logs, peers, disk, and DB Sync.                                |
| `MidnightBlockStalled`    | Best block unchanged for 15 minutes          | Check the database, RPC, peers, and node logs.                       |
| `MidnightPeersLow`        | Peer count below 3 for 10 minutes            | Check bootnodes, network reachability, and firewall rules.           |
| `NodeContainerRestarting` | Any container restart in the last 15 minutes | Inspect previous logs and exit code; repeated restarts are critical. |

Details, screenshots, and verification commands:
[docs/monitoring.md](./docs/monitoring.md).

## Security

See [SECURITY.md](./SECURITY.md)

## Infrastructure as Code

This stack uses Pulumi, not Terraform. The Section 5 equivalents are:

- **Modules:** `components/cardano`, `midnight-node`, `midnight-indexer`, and
  `monitoring`.
- **Environments:** `Pulumi.yaml` defaults plus stack config in `Pulumi.<stack>.yaml`
- **State:** the Pulumi backend; use a remote backend with locking for shared
  environments.
- **Dependencies:** `index.ts` wires Cardano → Midnight → optional indexer; DB
  Sync waits on the node socket, other components wait for database
- **Checks:** `npm test` and `pulumi preview`.
- **Deploy:** `pulumi up`; teardown: `pulumi destroy`.

## Assumptions

- One Kubernetes cluster with the OrangeLab core stack already deployed.
- Named Longhorn storage is used; one replica, no HA.
- The stack runs a full node. Validator keys and the WireGuard overlay are gated.
- Preprod is the default; other networks need matching config and bootnodes.
- Lab secrets live in Pulumi state; production uses external secret management.
