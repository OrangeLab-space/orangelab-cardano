# Monitoring

Prometheus and Grafana monitoring for the Cardano + Midnight stack. The stack
uses the Prometheus Operator and Grafana from the OrangeLab core stack.
`pulumi up` installs the ServiceMonitors, alert rules, and dashboard when
`prometheus:enabled` and `prometheus:enableComponentMonitoring` are true (the
defaults in [`Pulumi.yaml`](../../Pulumi.yaml)).

## Files

| File                                | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `servicemonitor-cardano.yaml`       | Scrapes the `cardano` Service metrics port           |
| `servicemonitor-midnight-node.yaml` | Scrapes the `midnight-node` Service metrics port     |
| `prometheus-rules.yaml`             | Cardano/Midnight alert definitions                   |
| `grafana-dashboard.json`            | Grafana dashboard (Pulumi deploys it to `OrangeLab`) |

The YAML files are consumed directly by the Pulumi `Monitoring` component, so the
committed manifests are the deployed manifests.

## Metrics

- **Cardano:** `cardano-node` binds Prometheus to `127.0.0.1:12798`. A `socat`
  sidecar republishes it on pod port `12799`, exposed by the `cardano` Service as
  `metrics`.
- **Midnight:** the node runs with `--prometheus-external` and serves `/metrics`
  on port `9615`. The `midnight-node` Service exposes it as `metrics`.
- **PostgreSQL:** CloudNativePG creates its own PodMonitor when component
  monitoring is enabled.
- **DB Sync:** no native Prometheus endpoint. Use
  [`scripts/db-sync-progress.sh`](../../scripts/db-sync-progress.sh) for block
  height, or add a PostgreSQL exporter if DB Sync lag must page.

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

`CardanoTipStalled` compares max/min height over 10 minutes and fires after 5
more minutes with no change, so the node must be static for 15 minutes.
`MidnightBlockStalled` uses the same window on `substrate_block_height{status="best"}`.
`MidnightPeersLow` tolerates brief churn and fires only after 10 minutes below
three peers. `NodeContainerRestarting` covers both namespaces; a restart during
a deployment is expected.

This is a **full node**, not a validator. Block-production and attestation alerts
are out of scope until validator mode is enabled.

## Deploy

Pulumi-managed (normal path):

```sh
pulumi up
```

Manual apply only if Pulumi does not manage these resources. Do not mix paths.

```sh
kubectl apply -f components/monitoring/servicemonitor-cardano.yaml
kubectl apply -f components/monitoring/servicemonitor-midnight-node.yaml
kubectl apply -f components/monitoring/prometheus-rules.yaml

kubectl create configmap cardano-midnight-dashboard -n cardano \
  --from-file=cardano-midnight.json=components/monitoring/grafana-dashboard.json \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl label configmap cardano-midnight-dashboard -n cardano \
  grafana_dashboard=1 --overwrite
kubectl annotate configmap cardano-midnight-dashboard -n cardano \
  k8s-sidecar-target-folder=OrangeLab --overwrite
```

The Grafana sidecar watches all namespaces.

## Verify

```sh
kubectl get servicemonitors -A | grep -E 'cardano|midnight-node'
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
curl -s 'http://localhost:9090/api/v1/query?query=cardano_node_metrics_blockNum_int' | jq
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
folder. Direct URL: `https://grafana.orangelab.space/d/cardano-midnight`.

If it does not appear:

```sh
kubectl -n prometheus logs deploy/prometheus-43506c55-grafana \
  -c grafana-sc-dashboard --tail=50
```

## Limitations

- DB Sync lag is not alerted because it has no native metrics endpoint.
- CPU and memory are dashboard signals, not paging alerts.
- Alerts assume the core stack's Prometheus Operator and Grafana are present.
