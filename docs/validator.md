# FNO Validator Mode

Optional block-production mode for the Midnight node. The default stack is a
fully synced full node.

Gated: overlay addresses, peer IDs, and the reserved peer list are in the
access-controlled `midnight-network-ops` repository. Request access and a
Foundation assignment first.

Prerequisites:

- Midnight node deployed and synced: [RUNBOOK](../RUNBOOK.md#phase-3-deploy-midnight)
- Foundation approval, overlay assignment, and reserved peers
- WireGuard tools `v1.0.20250521`
- Key storage and rotation plan: [SECURITY.md](../SECURITY.md)

## 1. Generate validator keys

Run inside the Midnight pod so keys land on `/node`. The image includes `jq`.

```sh
kubectl -n midnight-node exec -it deploy/midnight-node -- bash

NETWORK_NAME=preprod  # must match midnight-node:network
KEYSTORE=/node/chain/chains/midnight_$NETWORK_NAME/keystore
NETWORK_DIR=/node/chain/chains/midnight_$NETWORK_NAME/network
mkdir -p "$KEYSTORE" "$NETWORK_DIR"
chmod 700 "$NETWORK_DIR"

/midnight-node key generate --scheme sr25519 --output-type json > /node/aura.json
/midnight-node key generate --scheme ed25519 --output-type json > /node/grandpa.json
/midnight-node key generate --scheme ecdsa --output-type json > /node/cross_chain.json

/midnight-node key insert --keystore-path "$KEYSTORE" \
  --scheme sr25519 --key-type aura --suri "$(jq -r .secretPhrase /node/aura.json)"
/midnight-node key insert --keystore-path "$KEYSTORE" \
  --scheme ed25519 --key-type gran --suri "$(jq -r .secretPhrase /node/grandpa.json)"
/midnight-node key insert --keystore-path "$KEYSTORE" \
  --scheme ecdsa --key-type beef --suri "$(jq -r .secretPhrase /node/cross_chain.json)"

/midnight-node key generate-node-key --file "$NETWORK_DIR/secret_ed25519"
/midnight-node key inspect-node-key --file "$NETWORK_DIR/secret_ed25519"
```

Back up the seed files and network key offline. Never commit them. Build the
public registration file, then delete the seeds:

```sh
cat > /node/partner-chains-public-keys.json <<EOF
{
  "partner_chains_key": "$(jq -r .publicKey /node/cross_chain.json)",
  "keys": {
    "aura": "$(jq -r .publicKey /node/aura.json)",
    "crch": "$(jq -r .publicKey /node/cross_chain.json)",
    "gran": "$(jq -r .publicKey /node/grandpa.json)"
  }
}
EOF
cat /node/partner-chains-public-keys.json
rm /node/aura.json /node/grandpa.json /node/cross_chain.json
```

Send the public file to the Foundation. It contains public keys only.

## 2. Join the WireGuard overlay

The FNO docs require WireGuard tools `v1.0.20250521`.

```sh
wg genkey | tee privatekey | wg pubkey > publickey
```

Submit the public key, public IP:port, and peer ID from `key inspect-node-key`
through the Foundation's form. The Foundation returns the overlay IP and peer
assignments.

WireGuard is host-level networking and is not automated by this stack. Bring it
up on the Midnight node host, or run a privileged WireGuard pod, and verify with
`wg show`.

## 3. Enable validator mode

```sh
pulumi config set midnight-node:validator true
pulumi config set midnight-node:reservedNodes '<peer-1>,<peer-2>'
# FNO docs use 30; the preprod chain config uses 10. Follow the Foundation.
pulumi config set midnight-node:blockStabilityMargin 30
pulumi up
```

The pod restarts with `--validator --reserved-only --reserved-nodes ...`.

Never run two nodes with the same validator key.

## 4. Wait for n+2

- epoch `n`: added to whitelist, passive
- epoch `n+1`: queued, passive
- epoch `n+2`: joins the validator set and produces blocks

A lack of `Prepared block` logs in the first two epochs is expected. When
production starts, logs show `Prepared block`, `Pre-sealed block`, and
`Successfully proposed block`.

## Gotchas

| Gotcha            | Detail                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Validator overlay | Reserved peers and WireGuard assignment are not public. Without them you get a synced node, not a producer.   |
| n+2 epochs        | Block production starts two epochs after registration.                                                        |
| No blocks         | Check `wg show`, node logs, and registration status; confirm public keys were submitted, then wait for n+2.   |
| Key custody       | Seeds and keystore are hot keys. See [SECURITY.md](../SECURITY.md) for storage, rotation, and incident steps. |
