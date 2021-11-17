import { BN } from 'ethereumjs-util';
import { Transaction, Block, BlockHeader } from '@gxchain2/structure';
import { logger, Channel, createBufferFunctionalSet } from '@gxchain2/utils';
import { ProtocolHandler, Peer } from '@gxchain2/network';
import { NodeStatus } from '../../node';
import { PeerRequestTimeoutError } from '../types';
import { WireProtocol } from './protocol';
import { WireMessageFactory } from './wireMessageFactory';
import * as w from './wireMessage';

const maxTxPacketSize = 102400;
const maxKnownTxs = 32768;
const maxKnownBlocks = 1024;
const maxQueuedTxs = 4096;
const maxQueuedBlocks = 4;

/**
 * WireProtocolHandler is used to manage protocol communication between nodes
 */
export class WireProtocolHandler implements ProtocolHandler {
  readonly peer: Peer;
  readonly protocol: WireProtocol;

  private _status?: NodeStatus;
  private _knowTxs = createBufferFunctionalSet();
  private _knowBlocks = createBufferFunctionalSet();

  protected handshakeResolve?: (result: boolean) => void;
  protected handshakeTimeout?: NodeJS.Timeout;
  protected readonly handshakePromise: Promise<boolean>;

  protected readonly waitingRequests = new Map<
    number,
    {
      resolve: (data: any) => void;
      reject: (reason?: any) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  private newBlockAnnouncesQueue: Channel<{ block: Block; td: BN }>;
  private txAnnouncesQueue: Channel<Buffer>;

  constructor(protocol: WireProtocol, peer: Peer) {
    this.peer = peer;
    this.protocol = protocol;
    this.newBlockAnnouncesQueue = new Channel<{ block: Block; td: BN }>({ max: maxQueuedBlocks });
    this.txAnnouncesQueue = new Channel<Buffer>({ max: maxQueuedTxs });

    this.handshakePromise = new Promise<boolean>((resolve) => {
      this.handshakeResolve = resolve;
    });
    this.handshakePromise.then((result) => {
      if (result) {
        this.protocol.pool.add(this);
        this.announceTx(this.node.txPool.getPooledTransactionHashes());
      }
    });

    this.newBlockAnnouncesLoop();
    this.txAnnouncesLoop();
  }

  get status() {
    return this._status;
  }

  get node() {
    return this.protocol.node;
  }

  /**
   * Update node status
   * @param newStatus - New status
   */
  updateStatus(newStatus: Partial<NodeStatus>) {
    this._status = { ...this._status!, ...newStatus };
  }

  /**
   * {@link ProtocolHandler.handshake}
   */
  handshake() {
    if (!this.handshakeResolve) {
      throw new Error('repeated handshake');
    }
    this.send(new w.StatusMessage(this.node.status));
    this.handshakeTimeout = setTimeout(() => {
      if (this.handshakeResolve) {
        this.handshakeResolve(false);
        this.handshakeResolve = undefined;
      }
    }, 8000);
    return this.handshakePromise;
  }

  /**
   * Handshake response callback
   * @param status - New node status
   */
  handshakeResponse(status: NodeStatus) {
    if (this.handshakeResolve) {
      const localStatus = this.node.status;
      const result = localStatus.genesisHash.equals(status.genesisHash) && localStatus.networkId === status.networkId;
      if (result) {
        this.updateStatus(status);
      }
      this.handshakeResolve(result);
      this.handshakeResolve = undefined;
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = undefined;
      }
    }
  }

  /**
   * Send message to the remote peer
   * @param method - Method name or code
   * @param data - Message data
   */
  // send(method: string | number, data: any) {
  //   const handler = this.findHandler(method);
  //   this.peer.send(this.protocol.name, rlp.encode([intToBuffer(handler.code), handler.encode.call(this, data)]));
  // }

  send(msg: w.WireMessage) {
    this.peer.send(this.protocol.name, WireMessageFactory.serializeMessage(msg));
  }
  /**
   * Send message to the peer and wait for the response
   * @param method - Method name
   * @param data - Message data
   * @returns Response
   */
  request(msg: w.WireMessage) {
    if (!msg.response) {
      throw new Error(`invalid request: ${msg}`);
    }
    if (this.waitingRequests.has(msg.response!)) {
      throw new Error(`repeated request: ${msg}`);
    }
    return new Promise<any>((resolve, reject) => {
      this.waitingRequests.set(msg.response!, {
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.waitingRequests.delete(msg.response!);
          reject(new PeerRequestTimeoutError(`timeout request: ${msg}`));
        }, 8000)
      });
      this.send(msg);
    });
  }

  /**
   * {@link ProtocolHandler.abort}
   */
  abort() {
    if (this.handshakeResolve) {
      this.handshakeResolve(false);
      this.handshakeResolve = undefined;
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = undefined;
      }
    }

    for (const [, request] of this.waitingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('abort'));
    }
    this.waitingRequests.clear();

    this.newBlockAnnouncesQueue.abort();
    this.txAnnouncesQueue.abort();
    this.protocol.pool.remove(this);
  }

  /**
   * Handle the data received from the remote peer
   * @param data - Received data
   */
  async handle(data: Buffer) {
    const msg = WireMessageFactory.fromSerializedWireMessage(data);
    const code = WireMessageFactory.registry.getCodeByInstance(msg);
    const request = this.waitingRequests.get(code);

    if (request) {
      clearTimeout(request.timeout);
      this.waitingRequests.delete(code);
      request.resolve(data);
    } else {
      if (code !== 0 && !(await this.handshakePromise)) {
        logger.warn('WireProtocolHander::handle, handshake failed');
        return;
      }
      if (msg instanceof w.StatusMessage) {
        this.applyStatusMessage(msg);
      } else if (msg instanceof w.GetBlockHeadersMessage) {
        await this.applyGetBlockHeadersMessage(msg);
      } else if (msg instanceof w.GetBlockBodiesMessage) {
        await this.applyGetBlockBodiesMessage(msg);
      } else if (msg instanceof w.NewBlockMessage) {
        this.applyNewBlockMessage(msg);
      } else if (msg instanceof w.NewPooledTransactionHashesMessage) {
        this.applyNewPooledTransactionHashesMessage(msg);
      } else if (msg instanceof w.GetPooledTransactionsMessage) {
        this.applyGetPooledTransactionsMessage(msg);
      } else {
        logger.warn('WireProtocolHander::handler, unknown message');
        return;
      }
    }
  }

  private applyStatusMessage(msg: w.StatusMessage) {
    this.handshakeResponse(msg.data);
  }

  private async applyGetBlockHeadersMessage(msg: w.GetBlockHeadersMessage) {
    const blocks = await this.node.blockchain.getBlocks(msg.start, msg.count, 0, false);
    this.send(new w.BlockHeadersMessage(blocks.map((block) => block.header.raw())));
  }

  private async applyGetBlockBodiesMessage(msg: w.GetBlockBodiesMessage) {
    const bodies: Transaction[][] = [];
    for (const hash of msg.raw()) {
      try {
        const block = await this.node.db.getBlock(hash);
        bodies.push(block.transactions as Transaction[]);
      } catch (err: any) {
        if (err.type !== 'NotFoundError') {
          throw err;
        }
      }
    }
    this.send(new w.BlockBodiesMessage(bodies));
  }

  private applyNewBlockMessage(msg: w.NewBlockMessage) {
    const height = msg.block.header.number.toNumber();
    const bestHash = msg.block.hash();
    this.knowBlocks([bestHash]);
    const totalDifficulty = msg.td.toBuffer();
    this.updateStatus({ height, bestHash, totalDifficulty });
    this.node.sync.announce(this.peer);
  }

  private applyNewPooledTransactionHashesMessage(msg: w.NewPooledTransactionHashesMessage) {
    this.knowTxs(msg.hashes);
    this.node.txSync.newPooledTransactionHashes(this.peer.peerId, msg.hashes);
  }

  private applyGetPooledTransactionsMessage(msg: w.GetPooledTransactionsMessage) {
    const hashes = msg.hashes.map((hash) => this.node.txPool.getTransaction(hash)).filter((tx) => tx !== undefined);
    this.send(new w.PooledTransactionsMessage(hashes as Transaction[]));
  }

  private async newBlockAnnouncesLoop() {
    if (!(await this.handshakePromise)) {
      return;
    }

    for await (const { block, td } of this.newBlockAnnouncesQueue.generator()) {
      try {
        this.newBlock(block, td);
      } catch (err) {
        logger.error('WireProtocolHandler::newBlockAnnouncesLoop, catch error:', err);
      }
    }
  }

  private async txAnnouncesLoop() {
    if (!(await this.handshakePromise)) {
      return;
    }

    let hashesCache: Buffer[] = [];
    for await (const hash of this.txAnnouncesQueue.generator()) {
      hashesCache.push(hash);
      if (hashesCache.length < maxTxPacketSize && this.txAnnouncesQueue.array.length > 0) {
        continue;
      }
      try {
        this.newPooledTransactionHashes(hashesCache);
      } catch (err) {
        logger.error('WireProtocolHandler::txAnnouncesLoop, catch error:', err);
      }
      hashesCache = [];
    }
  }

  /**
   * Filter known data
   * @param know - Known data
   * @param data - All data
   * @param toHash - Convert data to hash
   * @returns Filtered data
   */
  private filterHash<T>(know: Set<Buffer>, data: T[], toHash?: (t: T) => Buffer) {
    const filtered: T[] = [];
    for (const t of data) {
      const hash = Buffer.isBuffer(t) ? t : toHash!(t);
      if (!know.has(hash)) {
        filtered.push(t);
      }
    }
    return filtered;
  }

  /**
   * filter out known transactions
   * @param data - All transactions
   * @param toHash - Convert data to hash
   * @returns Filtered transactions
   */
  private filterTxs<T>(data: T[], toHash?: (t: T) => Buffer) {
    return this.filterHash(this._knowTxs, data, toHash);
  }

  /**
   * Call filterHash, filter out known blocks
   * @param data - All blocks
   * @param toHash - Convert data to hash
   * @returns Filtered blocks
   */
  private filterBlocks<T>(data: T[], toHash?: (t: T) => Buffer) {
    return this.filterHash(this._knowBlocks, data, toHash);
  }

  /**
   * Add known data information
   * @param know - Previous data set
   * @param max - Maximum number of messages allowed to be stored
   * @param hashs - Data to be added
   */
  private knowHash(know: Set<Buffer>, max: number, hashs: Buffer[]) {
    if (hashs.length >= max) {
      throw new Error(`WireProtocolHandler invalid hash length: ${hashs.length}`);
    }
    while (know.size + hashs.length >= max) {
      const { value } = know.keys().next();
      know.delete(value);
    }
    for (const h of hashs) {
      know.add(h);
    }
  }

  /**
   * Call knowHash, add known transactions
   * @param hashs - Transactions to be added
   */
  knowTxs(hashs: Buffer[]) {
    this.knowHash(this._knowTxs, maxKnownTxs, hashs);
  }

  /**
   * Call knowHash, add known blocks
   * @param hashs - Blocks to be added
   */
  knowBlocks(hashs: Buffer[]) {
    this.knowHash(this._knowBlocks, maxKnownBlocks, hashs);
  }

  /**
   * Send new block message and add new block message to
   * the set of known set
   * @param block - New block
   * @param td - Total difficulty
   */
  private newBlock(block: Block, td: BN) {
    const filtered = this.filterBlocks([block], (b) => b.hash());
    if (filtered.length > 0) {
      this.send(new w.NewBlockMessage(block, td));
      this.knowBlocks([block.hash()]);
    }
  }

  // private newBlockHashes(hashes: Buffer[]) {
  //   const filtered = this.filterBlocks(hashes, (h) => h);
  //   if (filtered.length > 0) {
  //     this.send('NewBlockHashes', filtered);
  //     this.knowBlocks(filtered);
  //   }
  // }

  /**
   * Send new transactions which added to the pool
   * and add them to the known transactions set
   * the set of known set
   * @param - hashes
   */
  private newPooledTransactionHashes(hashes: Buffer[]) {
    const filtered = this.filterTxs(hashes, (h) => h);
    if (filtered.length > 0) {
      this.send(new w.NewPooledTransactionHashesMessage(filtered));
      this.knowTxs(filtered);
    }
  }

  /**
   * Make a request to get block headers
   * @param start - Start block number
   * @param count - Wanted blocks number
   * @returns The block headers
   */
  getBlockHeaders(start: number, count: number): Promise<BlockHeader[]> {
    const msg = new w.GetBlockHeadersMessage(start, count);
    return this.request(msg);
  }

  /**
   * Make a request to get block bodies
   * @param headers - Headers of blocks which wanted
   * @returns The block bodies
   */
  getBlockBodies(headers: BlockHeader[]): Promise<Transaction[][]> {
    const msg = new w.GetBlockBodiesMessage(headers.map((header) => header.hash()));
    return this.request(msg);
  }

  /**
   * Make a request to get pooled transactions
   * @param hashes - Transactions hashes
   * @returns Transactions
   */
  getPooledTransactions(hashes: Buffer[]): Promise<Transaction[]> {
    return this.request(new w.GetPooledTransactionsMessage(hashes));
  }

  /**
   * Push transactions into txAnnouncesQueue
   * @param hashes - Transactions' hashes
   */
  announceTx(hashes: Buffer[]) {
    for (const hash of hashes) {
      this.txAnnouncesQueue.push(hash);
    }
  }

  /**
   * Push block into newBlockAnnouncesQueue
   * @param block - Block object
   * @param td - Total difficulty
   */
  announceNewBlock(block: Block, td: BN) {
    this.newBlockAnnouncesQueue.push({ block, td });
  }
}
