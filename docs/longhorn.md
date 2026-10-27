# Longhorn Storage

Storage layout and named-volume workflow for the Cardano/Midnight stack. The
core stack must provide Longhorn with a `longhorn-large` StorageClass (one
replica).

## Layout

| Volume             | Size  | Contents                                       |
| ------------------ | ----- | ---------------------------------------------- |
| `cardano`          | 120Gi | Node `/data/db` + DB Sync `/var/lib/cexplorer` |
| `cardano-db`       | 50Gi  | PostgreSQL                                     |
| `midnight-node`    | 250Gi | Midnight node `/node`                          |
| `midnight-indexer` | 250Gi | Indexer `/data`                                |

`cardano` is one PVC mounted at both paths. The class has no disk selector, so a
dynamic replica may land on another node's default disk. Use Longhorn node
scheduling to exclude it.

## Lifecycle

- Dynamic volumes survive `pulumi up`; `pulumi destroy` deletes them.
- Named volumes use `fromVolume` and live outside the stack. They survive
  `pulumi destroy`.
- Before destroying, confirm the stack config still points at the intended named
  volumes. Never delete Longhorn volumes directly.
- Once `fromVolume` is set, `storageClass` is ignored.

## Static volumes

Use named Longhorn volumes when data must survive `pulumi destroy` or move
between stacks.

| Volume             | Size  | Source                           |
| ------------------ | ----- | -------------------------------- |
| `cardano`          | 120Gi | Clone dynamic `cardano`          |
| `cardano-db`       | 50Gi  | Clone initialized `cardano-db-1` |
| `midnight-node`    | 250Gi | Create empty                     |
| `midnight-indexer` | 250Gi | Create empty; optional           |

Deploy the dynamic stack first, verify the DB and pods, then clone. No need to
wait for full sync. Do this before enabling Midnight; hibernating the database
while Midnight runs stops it.

### Persist the database password

Persist the generated DB password before cloning. The new stack would otherwise
generate a new password while the cloned database keeps the old role password.

```sh
# Run in your terminal; this prints the generated password.
pulumi stack output apps --show-secrets --json | jq -r '.cardano.db.password'

pulumi config set --secret cardano:db/password '<value>'
```

### Clone to named volumes

Keep the DB cluster and its volume, stop the Cardano deployment, then hibernate
the DB so its volume detaches without deletion:

```sh
pulumi config set cardano:db/enabled true
pulumi config set cardano:storageOnly true
pulumi up

kubectl annotate cluster cardano-db -n cardano cnpg.io/hibernation=on

# The VOLUME column is the Longhorn volume name (pvc-...).
kubectl get pvc -n cardano -o wide
kubectl get pods -n cardano
```

Wait for the DB pod to disappear and the Cardano/DB volumes to become `detached`.
Clone in the Longhorn UI:

| Source PV (`VOLUME`)      | Clone name   |
| ------------------------- | ------------ |
| dynamic `cardano` PV      | `cardano`    |
| dynamic `cardano-db-1` PV | `cardano-db` |

Use **1 replica**, **Block Device**, **v1** data engine, **ReadWriteOnce**, and
the `cardano` disk selector. Add the disk tag under **Node → Edit node and
disks** if missing.

Clones inherit placement. If a clone lands on the wrong disk, set its disk
selector to `cardano`, scale replicas to **2**, wait for the new replica, delete
the old one, then scale back to **1**.

### Attach named volumes

```sh
pulumi config set cardano:fromVolume cardano
pulumi config set cardano:db/fromVolume cardano-db
pulumi config set cardano:requiredVolumeLabel kubernetes.io/hostname=<node>
pulumi config set cardano:db/requiredVolumeLabel kubernetes.io/hostname=<node>
kubectl annotate cluster cardano-db -n cardano cnpg.io/hibernation-
pulumi config delete cardano:storageOnly
pulumi up
```

For Midnight, create the volume empty, then set
`midnight-node:fromVolume midnight-node` and
`midnight-node:requiredVolumeLabel kubernetes.io/hostname=<node>`.

If a volume uses `strict-local`, its `nodeID` must match the pod node, otherwise
the pod stays in `FailedAttachVolume`.

## Resize storage

- Static `fromVolume` volumes need the app disabled before patching Longhorn.
- Dynamic volumes only need the new `storageSize`.
- Longhorn `spec.size` is bytes as a quoted number (`"268435456000"` for 250Gi),
  not `"250Gi"`.
- Volumes cannot shrink.

## Gotchas

| Gotcha                 | Detail                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Longhorn replicas      | Default class uses two replicas; this stack uses `longhorn-large` (one) to avoid duplicating hundreds of GiB. |
| Empty static DB volume | CNPG skips `initdb` on an uninitialized `cardano-db`. Clone the initialized `cardano-db-1` volume.            |
| PVCs pending           | Check `longhorn-large` exists and a node has free space: `kubectl get pvc -n cardano`.                        |
| Un-schedulable replica | A `strict-local` volume's `nodeID` does not match the PV node; repin it.                                      |

Check volumes with:

```sh
kubectl get volume.longhorn.io -n longhorn-system
```
