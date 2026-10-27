#!/usr/bin/env bash
#
# Run cardano-cli against the in-cluster Cardano node. The network flag is
# derived from `cardano:network`, so the same command works on preprod, preview,
# mainnet, or a custom testnet:
#
#   ./scripts/cardano-cli.sh query tip
#   ./scripts/cardano-cli.sh query utxo --address <addr>
#
# Override the stack network with CARDANO_NETWORK. For a network that is not
# preprod, preview, or mainnet, set CARDANO_NETWORK_MAGIC or the
# `cardano:networkMagic` stack config.
#
set -euo pipefail

cd "$(dirname "$0")/.."

network="${CARDANO_NETWORK:-}"
if [[ -z "$network" ]]; then
    network="$(pulumi config get cardano:network 2>/dev/null || true)"
fi
if [[ -z "$network" ]]; then
    echo "cardano-cli: set cardano:network or CARDANO_NETWORK" >&2
    exit 1
fi

magic="${CARDANO_NETWORK_MAGIC:-$(pulumi config get cardano:networkMagic 2>/dev/null || true)}"

network_args=()
case "$network" in
mainnet)
    network_args=(--mainnet)
    ;;
preprod)
    network_args=(--testnet-magic 1)
    ;;
preview)
    network_args=(--testnet-magic 2)
    ;;
*)
    if [[ -n "$magic" ]]; then
        network_args=(--testnet-magic "$magic")
    else
        echo "cardano-cli: unknown network '$network'; set CARDANO_NETWORK_MAGIC or cardano:networkMagic" >&2
        exit 1
    fi
    ;;
esac

# Do not append a second network flag when the caller supplied one.
for arg in "$@"; do
    if [[ "$arg" == "--mainnet" || "$arg" == "--testnet-magic" || "$arg" == --testnet-magic=* ]]; then
        network_args=()
        break
    fi
done

if ((${#network_args[@]})); then
    kubectl -n cardano exec deploy/cardano -c cardano -- \
        env CARDANO_NODE_SOCKET_PATH=/ipc/node.socket \
        cardano-cli "$@" "${network_args[@]}"
else
    kubectl -n cardano exec deploy/cardano -c cardano -- \
        env CARDANO_NODE_SOCKET_PATH=/ipc/node.socket \
        cardano-cli "$@"
fi
