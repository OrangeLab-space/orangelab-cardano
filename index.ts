import { config, mergeEndpointExports } from '@orangelab/pulumi';
import assert from 'assert';
import { Cardano } from './components/cardano/cardano';
import { MidnightIndexer } from './components/midnight-indexer/midnight-indexer';
import { MidnightNode } from './components/midnight-node/midnight-node';

const cardano = new Cardano('cardano');
const midnightNode = config.isEnabled('midnight-node')
    ? new MidnightNode('midnight-node', {
          db: cardano.dbConfig,
          dbWaitContainer: cardano.dbWaitContainer,
      })
    : undefined;

const indexerEnabled = config.isEnabled('midnight-indexer');
assert(
    !indexerEnabled || midnightNode,
    'midnight-indexer:enabled requires midnight-node:enabled',
);
const midnightIndexer =
    indexerEnabled && midnightNode
        ? new MidnightIndexer('midnight-indexer', { node: midnightNode })
        : undefined;

export const endpoints = mergeEndpointExports(cardano, midnightNode, midnightIndexer);

export const apps = {
    cardano: { db: cardano.dbConfig },
};
