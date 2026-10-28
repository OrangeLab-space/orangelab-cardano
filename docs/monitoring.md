# Monitoring

Prometheus and Grafana monitoring for the Cardano + Midnight stack. The stack
uses the Prometheus Operator and Grafana from the OrangeLab core stack.
`pulumi up` installs the ServiceMonitors, PodMonitors, alert rules, and dashboard
when `prometheus:enabled` and `prometheus:enableComponentMonitoring` are true
(the defaults in [`Pulumi.yaml`](../Pulumi.yaml)).

## Files

| File                                                                                              | Purpose                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`servicemonitor-cardano.yaml`](../components/monitoring/servicemonitor-cardano.yaml)             | Scrapes the Cardano node and sync exporter ports |
| [`podmonitor-cardano-db-sync.yaml`](../components/monitoring/podmonitor-cardano-db-sync.yaml)     | Scrapes DB Sync metrics on port 8080             |
| [`servicemonitor-midnight-node.yaml`](../components/monitoring/servicemonitor-midnight-node.yaml) | Scrapes the `midnight-node` Service metrics port |
| [`prometheus-rules.yaml`](../components/monitoring/prometheus-rules.yaml)                         | Cardano/Midnight alert definitions               |
| [`grafana-dashboard.json`](../components/monitoring/grafana-dashboard.json)                       | Cardano + DB Sync + Midnight dashboard           |

The YAML files are consumed directly by the Pulumi `Monitoring` component, so the
committed manifests are the deployed manifests.

## Deploy

Deploy through Pulumi:

```sh
pulumi config set prometheus:enableComponentMonitoring true
pulumi up
```

The Grafana sidecar watches all namespaces and picks up the dashboard ConfigMap.

## Metrics

- **Cardano:** `cardano-node` binds Prometheus to `127.0.0.1:12798`. A `socat`
  sidecar republishes it on pod port `12799`, exposed by the `cardano` Service as
  `metrics`.
- **Cardano sync:** a small sidecar runs `cardano-cli query tip` every 15 seconds
  and serves `cardano_node_sync_progress_percent` on pod port `12800`, exposed
  as `sync-metrics`. It also exports the tip slot, block, and epoch. This is the
  network-relative progress from the node itself; `blockReplayProgress` is only
  local ledger replay.
- **DB Sync:** exposes `cardano_db_sync_*` metrics on port `8080`. A PodMonitor
  scrapes the pod directly, so the dashboard can show block height, lag, and
  queue depth without a PostgreSQL exporter.
- **Midnight:** the node runs with `--prometheus-external` and serves `/metrics`
  on port `9615`. The `midnight-node` Service exposes it as `metrics`.
- **PostgreSQL:** CloudNativePG creates its own PodMonitor when component
  monitoring is enabled.

Metrics ports are cluster-only.

## Alert design

| Alert                     | Signal                                       | Why it matters                                                         | Response                                                                              |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CardanoTipStalled`       | Tip unchanged for 15 minutes                 | A node not receiving blocks cannot feed DB Sync.                       | Check `cardano-node` logs, peers, disk pressure, and DB Sync. Do not restart blindly. |
| `MidnightBlockStalled`    | Best block unchanged for 15 minutes          | The node is not importing blocks and will fall behind.                 | Check the DB connection, RPC, peers, and node logs.                                   |
| `MidnightPeersLow`        | Peer count below 3 for 10 minutes            | Low peers risk a sync stall and isolate the node.                      | Check bootnodes, network reachability, and firewall rules.                            |
| `NodeContainerRestarting` | Any container restart in the last 15 minutes | Restarts can indicate OOM, bad configuration, or a failing dependency. | Inspect previous logs and exit code. Repeated restarts are critical.                  |

## Screenshots from the last sync operation

Captured from the last sync run:

### Cardano

![Cardano dashboard row](monitoring%20-%20cardano.png)

Tip, peers, epoch, sync progress, ETA, block rate, and block fetch delay.

### DB Sync

![DB Sync dashboard row](monitoring%20-%20syncdb.png)

Database size, cache hit ratio, waiting backends, block-height lag, indexed block
height against the node tip, and write rate.

### Midnight

![Midnight dashboard row](monitoring%20-%20midnight.png)

Best and finalized block, peers, sync progress, remaining blocks, block rate,
block import time, and volume IOPS.

### Resources

![Resources dashboard row](monitoring%20-%20resources.png)

Deployment working set against configured limits, CPU, and major page faults.
