import { EventEmitter } from 'events';
import PeerId from 'peer-id';
import LevelStore from 'datastore-level';
import { logger } from '@gxchain2/utils';
import { Peer } from './peer';
import { Libp2pNode } from './libp2pnode';
import { Protocol } from './types';

export * from './peer';
export * from './types';

export declare interface NetworkManager {
  on(event: 'added' | 'installed' | 'removed', listener: (peer: Peer) => void): this;

  once(event: 'added' | 'installed' | 'removed', listener: (peer: Peer) => void): this;
}

export interface NetworkManagerOptions {
  peerId: PeerId;
  dbPath: string;
  protocols: Protocol[];
  maxSize?: number;
  tcpPort?: number;
  wsPort?: number;
  bootnodes?: string[];
}

const ignoredErrors = new RegExp(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].join('|'));

/**
 * Handle errors other than predicted errors or errors without error messages
 * @param err Pending errors
 */
function logError(err: any) {
  if (err.message && ignoredErrors.test(err.message)) {
    return;
  }
  if (err.errors) {
    if (Array.isArray(err.errors)) {
      for (const e of err.errors) {
        if (ignoredErrors.test(e.message)) {
          return;
        }
      }
    } else if (typeof err.errors === 'string') {
      if (ignoredErrors.test(err.errors)) {
        return;
      }
    }
  }
  logger.error('NetworkManager, error:', err);
}

export type PeerType = string | Peer | PeerId;

/**
 * NetworkManager manages nodes and node communications protocols connected
 * with local node
 */
export class NetworkManager extends EventEmitter {
  private readonly protocols: Protocol[];
  private readonly _peers = new Map<string, Peer>();
  private readonly banned = new Map<string, number>();
  private readonly maxSize: number;
  private readonly initPromise: Promise<void>;
  private libp2pNode!: Libp2pNode;

  constructor(options: NetworkManagerOptions) {
    super();
    this.maxSize = options.maxSize || 32;
    this.protocols = options.protocols;
    this.initPromise = this.init(options);
  }

  /**
   * Return all nodes recorded
   */
  get peers() {
    return Array.from(this._peers.values());
  }

  /**
   * Return `_peers` map's size
   */
  get size() {
    return this._peers.size;
  }

  private toPeer(peerId: PeerType) {
    if (typeof peerId === 'string') {
      return this._peers.get(peerId);
    } else if (peerId instanceof PeerId) {
      return this._peers.get(peerId.toB58String());
    } else {
      return peerId;
    }
  }

  private toPeerId(peerId: PeerType) {
    if (typeof peerId === 'string') {
      return peerId;
    } else if (peerId instanceof PeerId) {
      return peerId.toB58String();
    } else {
      return peerId.peerId;
    }
  }

  /**
   * Add peer info into the map when a peer connected
   * @param peerInfo The peer's infomation
   * @returns
   */
  private createPeer(peerInfo: PeerId) {
    const peer = new Peer(peerInfo.toB58String(), this);
    this._peers.set(peer.peerId, peer);
    this.emit('added', peer);
    return peer;
  }

  /**
   * Remove the peer's infomation when the peer is disconnected
   * @param peerId The peer's id
   */
  async removePeer(peerId: PeerType) {
    const peer = this.toPeer(peerId);
    if (peer) {
      if (this._peers.delete(peer.peerId)) {
        this.emit('removed', peer);
      }
      await peer.abort();
    }
  }

  /**
   * Get the peer's infomation by peerId
   * @param peerId
   * @returns The peer's infomation
   */
  getPeer(peerId: PeerType) {
    return this.toPeer(peerId);
  }

  /**
   * Set the node status to prohibited and remove from the map
   * @param peerId The peer to be banned
   * @param maxAge Prohibited duration
   * @returns
   */
  async ban(peerId: PeerType, maxAge = 60000) {
    this.banned.set(this.toPeerId(peerId), Date.now() + maxAge);
    await this.removePeer(peerId);
    return true;
  }

  /**
   * Determine whether a peer is banned
   * @param peerId peer's information
   * @returns `true` if the peer is banned, `false` if the peer is active
   */
  isBanned(peerId: PeerType): boolean {
    const id = this.toPeerId(peerId);
    const expireTime = this.banned.get(id);
    if (expireTime && expireTime > Date.now()) {
      return true;
    }
    this.banned.delete(id);
    return false;
  }

  /**
   * Initialization function, used to configure the operation of libp2p nodes
   * and start it to receive messages from other nodes
   * @param options
   * @returns
   */
  async init(options?: NetworkManagerOptions) {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    if (!options) {
      throw new Error('NetworkManager missing init options');
    }

    const datastore = new LevelStore(options.dbPath, { createIfMissing: true });
    await datastore.open();
    this.libp2pNode = new Libp2pNode({
      ...options,
      datastore
    });
    this.protocols.forEach((protocol) => {
      this.libp2pNode.handle(protocol.protocolString, async ({ connection, stream }) => {
        const peerId: PeerId = connection.remotePeer;
        try {
          const peer = this.toPeer(peerId);
          if (peer && (await peer.installProtocol(protocol, stream))) {
            logger.info('💬 Peer handled:', peer.peerId);
            this.emit('installed', peer);
          }
        } catch (err) {
          await this.removePeer(peerId);
          logError(err);
        }
      });
    });
    this.libp2pNode.on('peer:discovery', async (peerId: PeerId) => {
      const id = peerId.toB58String();
      try {
        if (this._peers.get(id) || this.isBanned(id)) {
          return;
        }
        const peer = this.createPeer(peerId);
        const results = await Promise.all(
          this.protocols.map(async (protocol) => {
            return peer.installProtocol(protocol, (await this.libp2pNode.dialProtocol(peerId, protocol.protocolString)).stream);
          })
        );
        if (results.reduce((a, b) => a || b, false)) {
          logger.info('💬 Peer discovered:', peer.peerId);
          this.emit('installed', peer);
        }
      } catch (err) {
        await this.removePeer(id);
        logError(err);
      }
    });
    this.libp2pNode.connectionManager.on('peer:connect', async (connect) => {
      const id = connect.remotePeer.toB58String();
      try {
        if (!this._peers.get(id)) {
          this.createPeer(connect.remotePeer);
          logger.info('💬 Peer connected:', id);
        }
      } catch (err) {
        await this.removePeer(id);
        logError(err);
      }
    });
    this.libp2pNode.connectionManager.on('peer:disconnect', async (connect) => {
      try {
        const id = connect.remotePeer.toB58String();
        await this.removePeer(id);
        logger.info('🤐 Peer disconnected:', id);
      } catch (err) {
        logError(err);
      }
    });

    // start libp2p
    await this.libp2pNode.start();
    logger.info('Libp2p has started', this.libp2pNode.peerId!.toB58String());
    this.libp2pNode.multiaddrs.forEach((ma) => {
      logger.info(ma.toString() + '/p2p/' + this.libp2pNode.peerId!.toB58String());
    });
  }

  /**
   * Stop all node connections and delete data
   */
  async abort() {
    await Promise.all(Array.from(this._peers.values()).map((peer) => peer.abort()));
    this._peers.clear();
    await this.libp2pNode.stop();
    this.removeAllListeners();
  }
}
