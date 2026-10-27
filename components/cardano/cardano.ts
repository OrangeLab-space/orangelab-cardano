import {
    Application,
    config,
    DatabaseConfig,
    InitContainerSpec,
    SidecarSpec,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'assert';

const NODE_METRICS_PORT = 12798;
const METRICS_PORT = 12799;

/**
 * Cardano relay node with cardano-db-sync and PostgreSQL.
 *
 * The network is selected by the `network` stack config, so the same component
 * can run mainnet, a testnet, or any other configured network.
 *
 * cardano-node and cardano-db-sync run in one pod because db-sync reads the
 * node's Unix socket; an emptyDir is shared at /ipc and /node-ipc. They also
 * share the app volume: the node uses /data/db, db-sync uses /var/lib/cexplorer.
 */
export class Cardano extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly dbConfig: DatabaseConfig;
    /** Init container that waits for the Cardano database to accept connections. */
    public readonly dbWaitContainer: InitContainerSpec;

    constructor(
        private readonly name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:cardano:Cardano', name, {}, opts);

        this.app = new Application(this, name);
        this.app.addStorage();
        this.app.addEmptyVolume({ name: 'ipc' });
        this.app.addPostgres();
        const databases = this.app.databases;
        assert(databases);
        this.dbConfig = databases.getConfig();
        this.dbWaitContainer = databases.getWaitContainer(this.dbConfig);
        this.createDeployment();
    }

    private createDeployment() {
        const network = config.require(this.name, 'network');

        this.app.addDeployment({
            env: { NETWORK: network },
            image: config.require(this.name, 'image'),
            initContainers: [this.dbWaitContainer],
            ports: [
                { name: 'p2p', port: 3001, protocol: 'tcp', private: true },
                { name: 'metrics', port: METRICS_PORT, protocol: 'tcp', private: true },
            ],
            resources: {
                requests: { cpu: '1', memory: '6Gi' },
                limits: { cpu: '4', memory: '12Gi' },
            },
            sidecars: [this.createDbSyncSidecar(network), this.createMetricsSidecar()],
            volumeMounts: [
                { mountPath: '/data' },
                { name: 'ipc', mountPath: '/ipc' },
            ],
        });
    }

    private createMetricsSidecar(): SidecarSpec {
        return {
            name: 'metrics-proxy',
            // cardano-node binds Prometheus to 127.0.0.1; republish it on the pod
            // network so the Service and ServiceMonitor can scrape it.
            image: 'alpine/socat:1.8.0.1',
            command: ['socat'],
            commandArgs: [
                `TCP-LISTEN:${METRICS_PORT},fork,reuseaddr`,
                `TCP:127.0.0.1:${NODE_METRICS_PORT}`,
            ],
            resources: {
                requests: { cpu: '10m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '32Mi' },
            },
        };
    }

    private createDbSyncSidecar(network: string): SidecarSpec {
        return {
            name: 'db-sync',
            image: config.require(this.name, 'db-sync/image'),
            command: ['/bin/bash', '-c'],
            commandArgs: [
                'until [ -S /node-ipc/node.socket ]; do ' +
                    'echo "waiting for cardano-node socket"; sleep 5; done; ' +
                    'exec /bin/entrypoint',
            ],
            env: {
                NETWORK: network,
                POSTGRES_DB: this.dbConfig.database,
                POSTGRES_HOST: this.dbConfig.hostname,
                POSTGRES_PORT: pulumi.interpolate`${this.dbConfig.port}`,
                POSTGRES_USER: this.dbConfig.username,
            },
            envSecret: { POSTGRES_PASSWORD: this.dbConfig.password },
            resources: {
                requests: { cpu: '1', memory: '4Gi' },
                limits: { cpu: '4', memory: '8Gi' },
            },
            volumeMounts: [
                { mountPath: '/var/lib' },
                { name: 'ipc', mountPath: '/node-ipc' },
            ],
        };
    }
}
