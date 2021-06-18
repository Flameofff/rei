import { EventEmitter } from 'events';
import { BN } from 'ethereumjs-util';
import { logger } from '@gxchain2/utils';
import { Peer } from '@gxchain2/network';
import type { Node } from '../node';

export interface SynchronizerOptions {
  node: Node;
  interval?: number;
}

export declare interface Synchronizer {
  on(event: 'start synchronize', listener: () => void): this;
  on(event: 'synchronized', listener: () => void): this;
  on(event: 'synchronize failed', listener: () => void): this;
  on(event: 'error', listener: (err: any) => void): this;

  once(event: 'start synchronize', listener: () => void): this;
  once(event: 'synchronized', listener: () => void): this;
  once(event: 'synchronize failed', listener: () => void): this;
  once(event: 'error', listener: (err: any) => void): this;
}

export class Synchronizer extends EventEmitter {
  protected readonly node: Node;
  protected readonly interval: number;
  protected running: boolean = false;
  protected forceSync: boolean = false;
  protected startingBlock: number = 0;
  protected highestBlock: number = 0;

  constructor(options: SynchronizerOptions) {
    super();
    this.node = options.node;
    this.interval = options.interval || 1000;
  }

  /**
   * Get the state of syncing
   */
  get syncStatus() {
    return { startingBlock: this.startingBlock, highestBlock: this.highestBlock };
  }

  /**
   *
   */
  get isSyncing(): boolean {
    throw new Error('Unimplemented');
  }

  protected startSyncHook(startingBlock: number, highestBlock: number) {
    this.startingBlock = startingBlock;
    this.highestBlock = highestBlock;
    this.emit('start synchronize');
  }

  protected async _sync(target?: { peer: Peer; height: number }): Promise<boolean> {
    throw new Error('Unimplemented');
  }

  /**
   * Sync the blocks
   * @param target - the sync peer and height of block
   */
  async sync(target?: { peer: Peer; height: number; td: BN }) {
    try {
      if (!this.isSyncing) {
        const beforeSync = this.node.blockchain.latestBlock.hash();
        const result = await this._sync(target);
        const afterSync = this.node.blockchain.latestBlock.hash();
        if (!beforeSync.equals(afterSync)) {
          if (result) {
            logger.info('💫 Synchronized');
            this.emit('synchronized');
          } else {
            this.emit('synchronize failed');
          }
          await this.node.newBlock(this.node.blockchain.latestBlock);
        }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  async syncAbort() {
    throw new Error('Unimplemented');
  }

  announce(peer: Peer, height: number, td: BN) {
    throw new Error('Unimplemented');
  }

  /**
   * Start the Synchronizer
   */
  async start() {
    if (this.running) {
      throw new Error('Synchronizer already started!');
    }
    this.running = true;
    const timeout = setTimeout(() => {
      this.forceSync = true;
    }, this.interval * 30);
    while (!this.node.aborter.isAborted) {
      await this.sync();
      await this.node.aborter.abortablePromise(new Promise((r) => setTimeout(r, this.interval)));
    }
    this.running = false;
    clearTimeout(timeout);
  }
}