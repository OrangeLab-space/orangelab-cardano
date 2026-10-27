import {
    Application,
    config,
    DatabaseConfig,
    InitContainerSpec,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'assert';

const METRICS_PORT = 9615;

export interface MidnightNodeArgs {
    db: DatabaseConfig;
    /** Init container from the Cardano component that waits for its database. */
    dbWaitContainer: InitContainerSpec;
}

/**
 * Midnight full node. The network is selected by the `network` stack config.
 * Validator mode additionally needs the Foundation-provided WireGuard overlay
 * and reserved peer list.
 */
export class MidnightNode extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly network: string;

    constructor(
        private readonly name: string,
        private readonly args: MidnightNodeArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:cardano:MidnightNode', name, args, opts);

        this.network = config.require(this.name, 'network');
        this.app = new Application(this, name);
        this.app.addStorage();
        this.createDeployment();
    }

    /**
     * WebSocket RPC endpoint for in-cluster consumers such as the indexer.
     */
    get rpcUrl(): pulumi.Output<string> {
        return pulumi.interpolate`ws://${this.name}.${this.app.metadata.namespace}:9944`;
    }

    private createDeployment() {
        const validator = config.requireBoolean(this.name, 'validator');
        const reservedNodes = config.getCommaSeparated(this.name, 'reservedNodes') ?? [];
        assert(
            !validator || reservedNodes.length > 0,
            `${this.name}:reservedNodes is required in validator mode`,
        );

        this.app.addDeployment({
            commandArgs: this.getCommandArgs(this.network, validator, reservedNodes),
            env: {
                ALLOW_NON_SSL: config.requireBoolean(this.name, 'allowNonSsl').toString(),
                BLOCK_STABILITY_MARGIN: config
                    .requireNumber(this.name, 'blockStabilityMargin')
                    .toString(),
                CARDANO_SECURITY_PARAMETER: config
                    .requireNumber(this.name, 'cardanoSecurityParameter')
                    .toString(),
                CFG_PRESET: this.network,
                NODE_NAME: config.require(this.name, 'nodeName'),
            },
            envSecret: {
                DB_SYNC_POSTGRES_CONNECTION_STRING: this.getConnectionString(),
            },
            // `--rpc-cors all` disables the RPC host filter, so /health is
            // reachable on the pod IP. It returns 200 while syncing, so the
            // readiness probe means RPC is up, not caught up; /health/readiness
            // is the caught-up signal.
            healthCheck: {
                httpGet: { path: '/health' },
            },
            image: config.require(this.name, 'image'),
            initContainers: [this.args.dbWaitContainer],
            ports: [
                { name: 'http', port: 9944, protocol: 'tcp', private: true },
                { name: 'p2p', port: 30333, protocol: 'tcp', private: true },
                { name: 'metrics', port: METRICS_PORT, protocol: 'tcp', private: true },
            ],
            // Midnight lists 16 GB RAM for a node. At 8 GB the kernel reclaims
            // the ledger_storage page cache, and re-reading it from Longhorn
            // produces hundreds of major page faults per second.
            resources: {
                requests: { cpu: '1', memory: '4Gi' },
                limits: { cpu: '4', memory: '16Gi' },
            },
            volumeMounts: [{ mountPath: '/node' }],
        });
    }

    private getCommandArgs(
        network: string,
        validator: boolean,
        reservedNodes: string[],
    ): string[] {
        const args = [
            '--chain',
            `/res/${network}/chain-spec-raw.json`,
            '--base-path',
            '/node/chain',
            '--name',
            config.require(this.name, 'nodeName'),
            '--pool-limit',
            config.requireNumber(this.name, 'poolLimit').toString(),
            '--rpc-external',
            '--rpc-methods',
            'safe',
            // The RPC host filter only accepts localhost by default, which
            // rejects every in-cluster client. The port is cluster-only, so
            // allow all origins rather than proxying every consumer.
            '--rpc-cors',
            'all',
            // The exporter defaults to 127.0.0.1; bind it to the pod network so
            // the ServiceMonitor can scrape it.
            '--prometheus-external',
            '--prometheus-port',
            METRICS_PORT.toString(),
        ];
        for (const bootnode of config.requireCommaSeparated(this.name, 'bootnodes')) {
            args.push('--bootnodes', bootnode);
        }
        if (validator) {
            args.push('--validator', '--reserved-only');
            for (const node of reservedNodes) args.push('--reserved-nodes', node);
        }
        return args;
    }

    private getConnectionString(): pulumi.Output<string> {
        const { database, hostname, password, port, username } = this.args.db;
        // Credentials must be URL-encoded: generated passwords can contain
        // reserved characters such as '/', '+', and '=' that would otherwise
        // terminate the authority section of the connection string.
        const encode = (value: pulumi.Input<string>) =>
            pulumi.output(value).apply(encodeURIComponent);
        return pulumi.interpolate`postgresql://${encode(username)}:${encode(password)}@${hostname}:${port}/${encode(database)}`;
    }
}
