# Cardano Stack

## Documentation

- [Monitoring](./docs/monitoring.md)
- [Security](./SECURITY.md)
- [Runbook](./RUNBOOK.md)

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

Grafana screenshots from last sync run at [docs/monitoring.md](./docs/monitoring.md)

## Project structure

| Path                                                             | Purpose                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`index.ts`](./index.ts)                                         | Pulumi entrypoint; wires Cardano, Midnight, indexer, and monitoring |
| [`components/cardano/`](./components/cardano/)                   | Cardano relay, DB Sync, PostgreSQL, and sync exporter               |
| [`components/midnight-node/`](./components/midnight-node/)       | Midnight full node                                                  |
| [`components/midnight-indexer/`](./components/midnight-indexer/) | Optional GraphQL indexer; requires an archive-pruned node           |
| [`components/monitoring/`](./components/monitoring/)             | ServiceMonitors, PodMonitors, alert rules, and Grafana dashboard    |
| [`Pulumi.yaml`](./Pulumi.yaml)                                   | Pulumi runtime and non-secret stack defaults                        |
| `Pulumi.<stack>.yaml`                                            | Local stack configuration and secrets (gitignored)                  |
| [`docs/`](./docs/)                                               | Monitoring, storage, and sync reference material                    |
| [`scripts/`](./scripts/)                                         | Cardano CLI and DB Sync progress helpers                            |
| [`RUNBOOK.md`](./RUNBOOK.md)                                     | Deployment, shutdown, and troubleshooting                           |
| [`SECURITY.md`](./SECURITY.md)                                   | Key management and incident response                                |

## Assumptions

- One Kubernetes cluster with the OrangeLab core stack already deployed.
- Named Longhorn storage is used; one replica, no HA.
- The stack runs a full node. Validator keys and the WireGuard overlay are gated.
- Preprod is the default; other networks need matching config and bootnodes.
- Lab secrets live in Pulumi state; production uses external secret management.
