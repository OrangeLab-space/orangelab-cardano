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

Alerts are outcome-based. CPU and memory are dashboard signals, not pages: sync
bursts are normal and Midnight memory is mostly reclaimable page cache.

| Alert                     | Signal                                       | Why it matters                                                         | Response                                                                              |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CardanoTipStalled`       | Tip unchanged for 15 minutes                 | A node not receiving blocks cannot feed DB Sync.                       | Check `cardano-node` logs, peers, disk pressure, and DB Sync. Do not restart blindly. |
| `MidnightBlockStalled`    | Best block unchanged for 15 minutes          | The node is not importing blocks and will fall behind.                 | Check the DB connection, RPC, peers, and node logs.                                   |
| `MidnightPeersLow`        | Peer count below 3 for 10 minutes            | Low peers risk a sync stall and isolate the node.                      | Check bootnodes, network reachability, and firewall rules.                            |
| `NodeContainerRestarting` | Any container restart in the last 15 minutes | Restarts can indicate OOM, bad configuration, or a failing dependency. | Inspect previous logs and exit code. Repeated restarts are critical.                  |

`CardanoTipStalled` compares max/min height across all pods over 10 minutes and
fires after 5 more minutes with no change, so the node must be static for 15
minutes. Aggregating avoids false positives from a terminated pod's stale series.
`MidnightBlockStalled` uses the same window on `substrate_block_height{status="best"}`.
`MidnightPeersLow` tolerates brief churn and fires only after 10 minutes below
three peers. `NodeContainerRestarting` covers both namespaces; a restart during
a deployment is expected.

This is a **full node**, not a validator. Block-production and attestation alerts
are out of scope until validator mode is enabled.

## Fresh sync

During catch-up, Alertmanager may show `NodeMemoryMajorPagesFaults` and
`NodeDiskIOSaturation`; both are expected while DB Sync and Midnight replay.
`CardanoTipStalled` must stay inactive while the Cardano tip advances. If
Midnight is enabled before DB Sync catches up, expect `NodeContainerRestarting`,
`MidnightBlockStalled`, and `MidnightPeersLow`; it exits with
`relation "ma_tx_out" does not exist` until the schema exists.

```sh
kubectl -n prometheus port-forward svc/prometheus-alertmanager 9093:9093
curl -s http://localhost:9093/api/v2/alerts \
  | jq -r '.[] | [.labels.alertname, .labels.severity, .status.state] | @tsv'
```

## Dashboard sections

The dashboard is grouped into **Cardano**, **DB Sync**, **Midnight**, and
**Resources**. The Cardano row shows tip, epoch, **sync progress**, and an
**ETA** derived from the last 10 minutes of progress. The DB Sync row shows
database health, **block-height lag** against the node, and the indexed block
height next to the node tip.

The ETA is a projection from recent progress, not a guarantee. Later epochs carry
more transactions, so replay slows down. For an authoritative block-height pair,
use [`scripts/db-sync-progress.sh`](../scripts/db-sync-progress.sh) and
[`scripts/cardano-cli.sh query tip`](../scripts/cardano-cli.sh).

## Screenshots from the last sync operation

Captured from the last sync run: Cardano is at the tip with 100% sync progress,
DB Sync is caught up with zero lag, and Midnight is still catching up.

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

## Deploy

Deploy through Pulumi:

```sh
pulumi up
```

The Grafana sidecar watches all namespaces and picks up the dashboard ConfigMap.

## Verify

```sh
kubectl get servicemonitors,podmonitors -A | grep -E 'cardano|midnight-node'
kubectl get prometheusrules -A | grep cardano

kubectl -n prometheus port-forward svc/prometheus-prometheus 9090:9090
```

```sh
# Scrape targets should be UP
curl -s http://localhost:9090/api/v1/targets |
  jq -r '.data.activeTargets[] | select(.labels.namespace|test("cardano|midnight-node")) | [.labels.job, .health, .lastError] | @tsv'

# Rules should be loaded and inactive
curl -s http://localhost:9090/api/v1/rules |
  jq -r '.data.groups[] | select(.name == "cardano-midnight.rules") | .rules[] | [.name, .state] | @tsv'

# Current values
curl -s 'http://localhost:9090/api/v1/query?query=cardano_node_sync_progress_percent' | jq
curl -s 'http://localhost:9090/api/v1/query?query=cardano_db_sync_db_block_height' | jq
curl -s 'http://localhost:9090/api/v1/query?query=substrate_block_height%7Bstatus%3D%22best%22%7D' | jq
```

Validate rule expressions with `promtool`. The `spec` field is extracted because
`promtool` expects rule groups, not the Kubernetes wrapper:

```sh
python3 -c 'import yaml,sys; print(yaml.safe_dump(yaml.safe_load(sys.stdin)["spec"]))' \
  < components/monitoring/prometheus-rules.yaml |
  kubectl -n prometheus exec -i prometheus-prometheus-0 -c prometheus -- \
    promtool check rules /dev/stdin
```

The dashboard is titled **Cardano + Midnight** (UID `cardano-midnight`). The
library requests the `OrangeLab` folder; the sidecar may place it in the default
folder. Direct URL: `https://grafana.<domain>/d/cardano-midnight`.

If it does not appear:

```sh
kubectl -n prometheus logs deploy/prometheus-43506c55-grafana \
  -c grafana-sc-dashboard --tail=50
```

## Limitations

- DB Sync lag is not alerted because it has no native metrics endpoint. The
  overview dashboard shows a write-rate proxy; use the script for block height.
- CPU and memory are dashboard signals, not paging alerts.
- Alerts assume the core stack's Prometheus Operator and Grafana are present.
