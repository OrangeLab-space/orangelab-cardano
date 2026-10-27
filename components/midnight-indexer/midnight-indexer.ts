import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { MidnightNode } from '../midnight-node/midnight-node';

export interface MidnightIndexerArgs {
    node: MidnightNode;
}

/**
 * Midnight indexer in standalone mode: the chain indexer, GraphQL API, wallet
 * indexer and SPO indexer in one container, backed by SQLite on its own volume.
 */
export class MidnightIndexer extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private readonly name: string,
        private readonly args: MidnightIndexerArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:cardano:MidnightIndexer', name, args, opts);

        this.app = new Application(this, name);
        this.app.addStorage();
        this.createDeployment();
    }

    private createDeployment() {
        this.app.addDeployment({
            env: {
                APP__APPLICATION__NETWORK_ID: this.args.node.network,
                APP__INFRA__NODE__URL: this.args.node.rpcUrl,
            },
            envSecret: {
                // Encrypts sensitive wallet data in the indexer database; losing
                // it makes the stored data unreadable, so it must be persisted.
                APP__INFRA__SECRET: config.requireSecret(this.name, 'secret'),
                // The standalone binary always runs the SPO indexer, which
                // requires a Blockfrost id even when stake data is unused.
                APP__INFRA__SPO_NODE__BLOCKFROST_ID:
                    config.getSecret(this.name, 'blockfrostId') ?? 'dummy-not-using-spo',
            },
            image: config.require(this.name, 'image'),
            ports: [{ name: 'http', port: 8088, protocol: 'http', private: true }],
            resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2', memory: '4Gi' },
            },
            // The image runs as appuser (uid 10001) and writes SQLite under /data.
            runAsUser: 10001,
            volumeMounts: [{ mountPath: '/data' }],
            volumeOwnerUserId: 10001,
        });
    }
}
