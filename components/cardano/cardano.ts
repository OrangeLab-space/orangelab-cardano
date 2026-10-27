import { Application, config, DatabaseConfig, SidecarSpec } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'assert';

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
        this.createDeployment();
    }

    private createDeployment() {
        const network = config.require(this.name, 'network');
        const databases = this.app.databases;
        assert(databases);

        this.app.addDeployment({
            env: { NETWORK: network },
            image: config.require(this.name, 'image'),
            initContainers: [databases.getWaitContainer(this.dbConfig)],
            ports: [{ name: 'p2p', port: 3001, protocol: 'tcp', private: true }],
            resources: {
                requests: { cpu: '1', memory: '6Gi' },
                limits: { cpu: '4', memory: '12Gi' },
            },
            sidecars: [this.createDbSyncSidecar(network)],
            volumeMounts: [
                { mountPath: '/data' },
                { name: 'ipc', mountPath: '/ipc' },
            ],
        });
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
