# Monitoring

Prometheus and Grafana monitoring for the Cardano + Midnight stack.

The stack uses the Prometheus Operator and Grafana already provided by the
OrangeLab core stack. `pulumi up` installs the ServiceMonitors, alert rules, and
dashboard when `prometheus:enabled` and
`prometheus:enableComponentMonitoring` are true (the defaults in
[`Pulumi.yaml`](../../Pulumi.yaml)).

## Files

| File                                | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `servicemonitor-cardano.yaml`       | Scrapes the `cardano` Service metrics port           |
| `servicemonitor-midnight-node.yaml` | Scrapes the `midnight-node` Service metrics port     |
| `prometheus-rules.yaml`             | Cardano/Midnight alert definitions                   |
| `grafana-dashboard.json`            | Grafana dashboard (Pulumi deploys it to `OrangeLab`) |

The YAML files are consumed directly by the Pulumi `Monitoring` component, so
the committed manifests are the deployed manifests.

## How metrics are exposed

- **Cardano:** `cardano-node` binds its Prometheus endpoint to
  `127.0.0.1:12798`. A small `socat` sidecar republishes it on pod port `12799`,
  which the `cardano` Service exposes as `metrics`.
- **Midnight:** the node runs with `--prometheus-external` and serves `/metrics`
  on port `9615`. The `midnight-node` Service exposes it as `metrics`.
- **PostgreSQL:** CloudNativePG creates its own PodMonitor when component
  monitoring is enabled.
- **DB Sync:** there is no native Prometheus endpoint. Use
  [`scripts/db-sync-progress.sh`](../../scripts/db-sync-progress.sh) for its block
  height, or add a custom PostgreSQL exporter if DB Sync lag needs to page.

Both metrics ports are cluster-only; they are not published outside the cluster.

## Alert design

The alerts are intentionally outcome-based. CPU and memory panels are useful for
diagnosis, but they are not primary alerts: Midnight memory is dominated by
reclaimable page cache, and CPU bursts during sync are normal. Alerting on those
signals produces noise without proving the node is unhealthy.

| Alert                     | Signal                                       | Why it matters                                                              | Response                                                                                          |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `CardanoTipStalled`       | Block height does not change for 15 minutes  | A node that is not receiving or applying blocks cannot feed DB Sync.        | Check `cardano-node` logs, peer connectivity, disk pressure, and DB Sync. Do not restart blindly. |
| `MidnightBlockStalled`    | Best block does not change for 15 minutes    | The Midnight node is not importing blocks and will fall behind the network. | Check the DB connection, RPC, peers, and node logs.                                               |
| `MidnightPeersLow`        | Peer count below 3 for 10 minutes            | Low peers risk a sync stall and isolate the node from the network.          | Check bootnodes, network reachability, and firewall rules.                                        |
| `NodeContainerRestarting` | Any container restart in the last 15 minutes | Restarts can indicate OOM, bad configuration, or a failing dependency.      | Inspect previous logs and exit code. Repeated restarts should be treated as critical.             |

### Cardano tip stalled

`CardanoTipStalled` compares the maximum and minimum block height over 10
minutes. It fires after 5 more minutes with no change, so the node must be
static for at least 15 minutes. Check the node before restarting it: a restart
throws away in-memory progress and can make the outage longer.

### Midnight block stalled

`MidnightBlockStalled` uses the same no-change window on
`substrate_block_height{status="best"}`. A database outage and a network outage
look the same from this metric, so check both the PostgreSQL connection and the
peer count before acting.

### Midnight peers low

`MidnightPeersLow` tolerates brief peer churn and fires only after 10 minutes
below three peers. If the count reaches zero, block import will stop and
`MidnightBlockStalled` will follow.

### Container restarting

`NodeContainerRestarting` covers both namespaces. A single restart during a
deployment is expected; a restart outside a deployment is not. Look for
`OOMKilled`, configuration errors, and dependency failures in the previous
container logs.

This is a **full node**, not a validator. Validator-mode block production is
gated by the Foundation, so block-production and attestation alerts are not
applicable until validator mode is enabled.

## Deploy

Pulumi-managed (normal path):

```sh
pulumi up
```

Manual apply (if the stack is already running and you are not using the Pulumi
resources). Do not apply these manually while Pulumi manages them; use one path
or the other.

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

The dashboard ConfigMap is picked up by the Grafana sidecar, which watches all
namespaces.

## Verify

```sh
kubectl get servicemonitors -A | grep -E 'cardano|midnight-node'
kubectl get prometheusrules -A | grep cardano

kubectl -n prometheus port-forward svc/prometheus-prometheus 9090:9090
```

Then check:

```sh
# Scrape targets should be UP
curl -s http://localhost:9090/api/v1/targets |
  jq -r '.data.activeTargets[] | select(.labels.namespace|test("cardano|midnight-node")) | [.labels.job, .health, .lastError] | @tsv'

# Alert rules should be loaded and inactive
curl -s http://localhost:9090/api/v1/rules |
  jq -r '.data.groups[] | select(.name == "cardano-midnight.rules") | .rules[] | [.name, .state] | @tsv'

# Current values
curl -s 'http://localhost:9090/api/v1/query?query=cardano_node_metrics_blockNum_int' | jq
curl -s 'http://localhost:9090/api/v1/query?query=substrate_block_height%7Bstatus%3D%22best%22%7D' | jq
```

Validate the rule expressions with `promtool`. The command extracts the
`spec` field because `promtool check rules` expects the rule groups, not the
Kubernetes wrapper:

```sh
python3 -c 'import yaml,sys; print(yaml.safe_dump(yaml.safe_load(sys.stdin)["spec"]))' \
  < components/monitoring/prometheus-rules.yaml |
  kubectl -n prometheus exec -i prometheus-prometheus-0 -c prometheus -- \
    promtool check rules /dev/stdin
```

The dashboard is titled **Cardano + Midnight** (UID `cardano-midnight`). The
library requests the `OrangeLab` folder, but the sidecar may place it in the
default folder. Direct URL: `https://grafana.orangelab.space/d/cardano-midnight`.

Check the Grafana sidecar logs if it does not appear:

```sh
kubectl -n prometheus logs deploy/prometheus-43506c55-grafana \
  -c grafana-sc-dashboard --tail=50
```

## Limitations

- DB Sync lag is not alerted because it has no native metrics endpoint. The
  runbook script remains the source of truth for DB Sync progress.
- CPU and memory are dashboard signals, not paging alerts.
- Node-level alerts assume the Core stack’s Prometheus Operator and Grafana are
  present; the stack does not install them itself.
