import { config, mergeEndpointExports } from '@orangelab/pulumi';
import assert from 'assert';
import { Cardano } from './components/cardano/cardano';
const cardano = new Cardano('cardano');
const midnightNode = config.isEnabled('midnight-node')
    ? new MidnightNode('midnight-node', { db: cardano.dbConfig })
    : undefined;

export const apps = {
    cardano: { db: cardano.dbConfig },
};
