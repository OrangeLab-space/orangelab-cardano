# Longhorn Storage

Storage layout, resizing, and troubleshooting for the Cardano/Midnight stack.
The core stack must provide Longhorn. The stack uses `longhorn-large` for
dynamic volumes and a dedicated `longhorn-cardano-db` StorageClass for the first
DB bootstrap.

## Layout

| Volume                     | Size  | Contents                                       |
| -------------------------- | ----- | ---------------------------------------------- |
| `cardano`                  | 120Gi | Node `/data/db` + DB Sync `/var/lib/cexplorer` |
| `cardano-db`               | 50Gi  | PostgreSQL                                     |
| `cardano-midnight`         | 250Gi | Midnight node `/node`                          |
| `cardano-midnight-indexer` | 250Gi | Indexer `/data`; optional                      |

The app volumes are static. `cardano-db` is created by cloning the initialized
dynamic DB volume and is static thereafter.

## Lifecycle

- Named volumes survive `pulumi up` and `pulumi destroy`.
- The DB starts dynamic only for the first bootstrap. After CNPG `initdb` and
  DB Sync schema creation, clone it to `cardano-db`.
- Do not delete Longhorn volumes directly. Delete the stack instead.

## Placement

Use `dataLocality: best-effort`, the Longhorn node tag `cardano` for the Cardano
node, and the disk tag `ssd` for the local NVMe. Create the DB StorageClass with the same
selectors:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: longhorn-cardano-db
provisioner: driver.longhorn.io
parameters:
    numberOfReplicas: '1'
    staleReplicaTimeout: '2880'
    dataLocality: best-effort
    nodeSelector: cardano
    diskSelector: ssd
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

Tag the Cardano Longhorn node with `cardano`; the local disk needs the `ssd` tag.
Check placement before syncing:

```sh
kubectl -n longhorn-system get replicas.longhorn.io \
  -o custom-columns=VOLUME:.spec.volumeName,NODE:.spec.nodeID,DISK:.spec.diskID
```

## Resize storage

- Change `cardano:storageSize`, `cardano:db/storageSize`,
  `midnight-node:storageSize`, or `midnight-indexer:storageSize`.
- Run `pulumi up`. Longhorn expands the PVC; volumes cannot shrink.
- Check `kubectl -n cardano get pvc` and
  `kubectl -n longhorn-system get volume`.

## Named volumes

Create the empty app volumes before the first deploy:

| Volume                     | Size  | Source                           |
| -------------------------- | ----- | -------------------------------- |
| `cardano`                  | 120Gi | Create empty                     |
| `cardano-db`               | 50Gi  | Clone initialized `cardano-db-1` |
| `cardano-midnight`         | 250Gi | Create empty                     |
| `cardano-midnight-indexer` | 250Gi | Create empty; optional           |

Deploy with the static app volumes and a dynamic DB. Wait until CNPG has run
`initdb` and DB Sync has created its schema (~10 minutes), then clone the DB.
Do this before enabling Midnight; hibernating the database while Midnight runs
stops it.

### Persist the database password

If you are creating the stack from scratch, set the password before the first
`pulumi up`. No need to read a generated value later:

```sh
pulumi config set --secret cardano:db/password "$(openssl rand -hex 32)"
```

If the stack already exists, Pulumi generated the password on first deploy.
Persist that existing value before cloning. Run this in your terminal:

```sh
pulumi stack output apps --show-secrets --json | jq -r '.cardano.db.password'
pulumi config set --secret cardano:db/password '<value>'
```

Do not set a new password on an existing initialized database: the role password
inside the data volume would not match. If you must rotate it, update the
PostgreSQL role first, then set the config. If the volume came from another
stack, use that stack's password or reset the role in the clone.

### Clone the DB to `cardano-db`

Stop the app and hibernate the DB so the dynamic volume detaches:

```sh
pulumi config set cardano:storageOnly true
pulumi up
kubectl annotate cluster cardano-db -n cardano cnpg.io/hibernation=on

# The VOLUME column is the dynamic Longhorn volume name (pvc-...).
kubectl get pvc -n cardano -o wide
kubectl get pods -n cardano
```

Wait for the DB pod to disappear and the dynamic DB volume to become `detached`.
Clone it with a `Volume` CR:

```yaml
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
    name: cardano-db
    namespace: longhorn-system
spec:
    size: '53687091200'
    numberOfReplicas: 1
    dataEngine: v1
    dataSource: 'vol://<dynamic-db-volume>'
    cloneMode: full-copy
    dataLocality: best-effort
    nodeSelector:
        - cardano
    diskSelector:
        - ssd
    staleReplicaTimeout: 2880
    accessMode: rwo
    frontend: blockdev
```

Wait for `status.cloneStatus.state: completed` and `status.state: detached`.
Then remove the dynamic DB PVC and Cluster resource so CNPG adopts the static
volume cleanly:

```sh
kubectl -n cardano delete pvc cardano-db-1
kubectl -n cardano delete cluster cardano-db
```

Attach the static volumes:

```sh
pulumi config set cardano:fromVolume cardano
pulumi config set cardano:db/fromVolume cardano-db
pulumi config set cardano:requiredVolumeLabel kubernetes.io/hostname=<node>
pulumi config set cardano:db/requiredVolumeLabel kubernetes.io/hostname=<node>
pulumi config delete cardano:storageOnly
pulumi up
```

For Midnight, create `cardano-midnight` empty and set
`midnight-node:fromVolume cardano-midnight` plus
`midnight-node:requiredVolumeLabel`. The indexer uses
`cardano-midnight-indexer` the same way.

If CNPG reports `Cluster is unrecoverable and needs manual intervention` after
the swap, it still references the old PVC identity. Delete the `Cluster` resource
and run `pulumi up`; the cloned PVC and its data are retained:

```sh
kubectl -n cardano delete cluster cardano-db
pulumi up
```

The named volumes use `dataLocality: best-effort`. If a pod cannot attach, check
that the Cardano Longhorn node has the `cardano` tag and the local disk has the
`ssd` tag.

## Gotchas

| Gotcha                 | Detail                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Longhorn replicas      | Default class uses two replicas; this stack uses `longhorn-large` (one) to avoid duplicating hundreds of GiB.                                     |
| Empty static DB volume | CNPG skips `initdb` on an uninitialized `cardano-db`. Clone the initialized `cardano-db-1` volume.                                                |
| PVCs pending           | Check the StorageClass and that the Cardano node has the `cardano` node tag and `ssd` disk tag: `kubectl get pvc -n cardano`.                     |
| Un-schedulable replica | The volume's node/disk selector does not match a schedulable node; check the Longhorn node and disk tags.                                         |
| Clone too early        | Wait for CNPG `initdb` and DB Sync schema creation (~10 minutes). An empty clone cannot start PostgreSQL.                                         |
| Volume on slow disk    | Check replica placement; use the `cardano` node tag and `ssd` disk tag so volumes stay on the local NVMe.                                         |
| CNPG unrecoverable     | After swapping the DB volume, CNPG may keep the old instance identity. Delete the `Cluster` resource and `pulumi up`; the cloned PVC is retained. |

Check volumes with:

```sh
kubectl get volume.longhorn.io -n longhorn-system
```
