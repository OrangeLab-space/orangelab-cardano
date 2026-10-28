/**
 * Prometheus exporter for the network-relative sync progress reported by
 * `cardano-cli query tip`. It runs as a sidecar next to cardano-node, reads the
 * node socket, and serves metrics over HTTP on port 12800.
 *
 * Keep the script POSIX-shell friendly except for the bash regex matching; the
 * cardano-node image includes bash, socat, and cardano-cli but not jq or sed.
 */
export const SYNC_EXPORTER_SCRIPT = `#!/bin/bash
set -u

OUT=/tmp/sync-metrics
PORT=12800

if [[ "\${1:-}" == "serve" ]]; then
    printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain; version=0.0.4\\r\\nConnection: close\\r\\n\\r\\n'
    if [[ -s "$OUT" ]]; then cat "$OUT"; else printf '# no metrics yet\\n'; fi
    exit 0
fi

case "\${NETWORK:-}" in
    mainnet) network_args=(--mainnet) ;;
    preprod) network_args=(--testnet-magic 1) ;;
    preview) network_args=(--testnet-magic 2) ;;
    *) network_args=(--testnet-magic "\${NETWORK_MAGIC:?NETWORK_MAGIC is required}") ;;
esac

socat TCP-LISTEN:$PORT,fork,reuseaddr SYSTEM:"/bin/bash /tmp/sync-exporter.sh serve" &

while true; do
    tip="$(timeout 20 env CARDANO_NODE_SOCKET_PATH=/ipc/node.socket cardano-cli query tip "\${network_args[@]}" 2>/dev/null || true)"
    progress=""
    slot=""
    block=""
    epoch=""
    sync_re='"syncProgress": "([0-9.]+)"'
    slot_re='"slot": ([0-9]+)'
    block_re='"block": ([0-9]+)'
    epoch_re='"epoch": ([0-9]+)'
    [[ $tip =~ $sync_re ]] && progress="\${BASH_REMATCH[1]}"
    [[ $tip =~ $slot_re ]] && slot="\${BASH_REMATCH[1]}"
    [[ $tip =~ $block_re ]] && block="\${BASH_REMATCH[1]}"
    [[ $tip =~ $epoch_re ]] && epoch="\${BASH_REMATCH[1]}"
    if [[ -n "$progress" ]]; then
        {
            echo '# HELP cardano_node_sync_progress_percent Network-relative sync progress from cardano-cli query tip.'
            echo '# TYPE cardano_node_sync_progress_percent gauge'
            echo "cardano_node_sync_progress_percent $progress"
            echo '# HELP cardano_node_tip_slot Cardano node tip slot.'
            echo '# TYPE cardano_node_tip_slot gauge'
            echo "cardano_node_tip_slot $slot"
            echo '# HELP cardano_node_tip_block Cardano node tip block height.'
            echo '# TYPE cardano_node_tip_block gauge'
            echo "cardano_node_tip_block $block"
            echo '# HELP cardano_node_tip_epoch Cardano node tip epoch.'
            echo '# TYPE cardano_node_tip_epoch gauge'
            echo "cardano_node_tip_epoch $epoch"
        } > "$OUT"
    fi
    sleep 15
done
`;
