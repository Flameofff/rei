import path from 'path';
import type { LevelUp } from 'levelup';
import LevelStore from 'datastore-level';
import { bufferToHex, BN, BNLike } from 'ethereumjs-util';
import { SecureTrie as Trie } from 'merkle-patricia-tree';
import { Database, createLevelDB } from '@rei-network/database';
import { NetworkManager, Peer } from '@rei-network/network';
import { Common, getChain } from '@rei-network/common';
import { Blockchain } from '@rei-network/blockchain';
import VM from '@gxchain2-ethereumjs/vm';
import EVM from '@gxchain2-ethereumjs/vm/dist/evm/evm';
import TxContext from '@gxchain2-ethereumjs/vm/dist/evm/txContext';
import { DefaultStateManager as StateManager } from '@gxchain2-ethereumjs/vm/dist/state';
import { Transaction, Block, CLIQUE_EXTRA_VANITY } from '@rei-network/structure';
import { Channel, Aborter, logger } from '@rei-network/utils';
import { AccountManager } from '@rei-network/wallet';
import { TxPool } from './txpool';
import { Synchronizer } from './sync';
import { TxFetcher } from './txSync';
import { BloomBitsIndexer, ChainIndexer } from './indexer';
import { BloomBitsFilter, BloomBitsBlocks, ConfirmsBlockNumber } from './bloombits';
import { BlockchainMonitor } from './blockchainMonitor';
import { WireProtocol, ConsensusProtocol } from './protocols';
import { ValidatorSets } from './staking';
import { StakeManager, Contract } from './contracts';
import { ConsensusEngine, ReimintConsensusEngine, CliqueConsensusEngine, ConsensusType, ExtraData, EvidencePool, EvidenceDatabase, Evidence } from './consensus';
import { EMPTY_ADDRESS } from './utils';
import { isEnableRemint, getConsensusTypeByCommon } from './hardforks';
import { Initializer, CommitBlockOptions, NodeOptions, NodeStatus } from './types';
import { VMMaster } from './link';

const defaultTimeoutBanTime = 60 * 5 * 1000;
const defaultInvalidBanTime = 60 * 10 * 1000;
const defaultChainName = 'rei-mainnet';

type PendingTxs = {
  txs: Transaction[];
  resolve: (results: boolean[]) => void;
};

type CommitBlock = {
  options: CommitBlockOptions;
  resolve: (result: boolean) => void;
  reject: (reason?: any) => void;
};

export class Node extends Initializer {
  readonly datadir: string;
  readonly chain: string;
  readonly networkId: number;
  readonly chainId: number;
  readonly genesisHash: Buffer;
  readonly nodedb: LevelUp;
  readonly evidencedb: LevelUp;
  readonly master: VMMaster;
  readonly networkdb: LevelStore;
  readonly wire: WireProtocol;
  readonly consensus: ConsensusProtocol;
  readonly db: Database;
  readonly networkMngr: NetworkManager;
  readonly sync: Synchronizer;
  readonly txPool: TxPool;
  readonly txSync: TxFetcher;
  readonly bloomBitsIndexer: ChainIndexer;
  readonly bcMonitor: BlockchainMonitor;
  readonly accMngr: AccountManager;
  readonly reimint: ReimintConsensusEngine;
  readonly clique: CliqueConsensusEngine;
  readonly evpool: EvidencePool;
  readonly aborter = new Aborter();
  readonly validatorSets = new ValidatorSets();

  private pendingTxsLoopPromise!: Promise<void>;
  private commitBlockLoopPromise!: Promise<void>;
  private readonly pendingTxsQueue = new Channel<PendingTxs>();
  private readonly commitBlockQueue = new Channel<CommitBlock>();

  private latestBlock!: Block;
  private totalDifficulty!: BN;

  constructor(options: NodeOptions) {
    super();

    this.datadir = options.databasePath;
    this.nodedb = createLevelDB(path.join(this.datadir, 'nodes'));
    this.evidencedb = createLevelDB(path.join(this.datadir, 'evidence'));
    this.networkdb = new LevelStore(path.join(this.datadir, 'networkdb'), { createIfMissing: true });
    this.wire = new WireProtocol(this);
    this.consensus = new ConsensusProtocol(this);
    this.accMngr = new AccountManager(options.account.keyStorePath);
    this.master = new VMMaster(path.join(__dirname, '/workers/vmWorker.js'), this);

    this.chain = options.chain ?? defaultChainName;
    /////// unsupport rei-mainnet ///////
    if (this.chain === defaultChainName) {
      throw new Error('Unspport mainnet!');
    }
    /////// unsupport rei-mainnet ///////
    if (getChain(this.chain) === undefined) {
      throw new Error(`Unknown chain: ${this.chain}`);
    }

    const common = this.getCommon(0);
    // TODO: fix type
    this.db = new Database(this.master as any, common);
    this.networkId = common.networkIdBN().toNumber();
    this.chainId = common.chainIdBN().toNumber();
    this.evpool = new EvidencePool({ backend: new EvidenceDatabase(this.evidencedb) });
    this.clique = new CliqueConsensusEngine({ ...options.mine, node: this });
    this.reimint = new ReimintConsensusEngine({ ...options.mine, node: this });

    const genesisBlock = Block.fromBlockData({ header: common.genesis() }, { common });
    this.genesisHash = genesisBlock.hash();
    logger.info('Read genesis block from file', bufferToHex(this.genesisHash));

    this.networkMngr = new NetworkManager({
      ...options.network,
      protocols: [this.wire, this.consensus],
      datastore: this.networkdb,
      nodedb: this.nodedb,
      bootnodes: [...common.bootstrapNodes(), ...(options.network.bootnodes ?? [])]
    })
      .on('installed', this.onPeerInstalled)
      .on('removed', this.onPeerRemoved);

    this.sync = new Synchronizer({ node: this }).on('synchronized', this.onSyncOver).on('failed', this.onSyncOver);
    this.txPool = new TxPool({ node: this, journal: this.datadir });
    this.txSync = new TxFetcher(this);
    this.bcMonitor = new BlockchainMonitor(this.db);
    this.bloomBitsIndexer = BloomBitsIndexer.createBloomBitsIndexer({ db: this.db, sectionSize: BloomBitsBlocks, confirmsBlockNumber: ConfirmsBlockNumber });
  }

  /**
   * Get the status of the node syncing
   */
  get status(): NodeStatus {
    return {
      networkId: this.networkId,
      totalDifficulty: this.totalDifficulty.toArrayLike(Buffer),
      height: this.latestBlock.header.number.toNumber(),
      bestHash: this.latestBlock.hash(),
      genesisHash: this.genesisHash
    };
  }

  /**
   * Initialize the node
   */
  async init() {
    this.master.start();
    await this.master.init(this.datadir, this.chain);

    this.latestBlock = await this.master.latestBlock();
    this.totalDifficulty = await this.master.totalDifficulty(this.latestBlock.hash(), this.latestBlock.header.number);
    if (this.latestBlock.header.number.eqn(0)) {
      await this.master.generateGenesis();
    }

    await this.networkdb.open();
    await this.networkMngr.init();
    await this.txPool.init(this.latestBlock);
    await this.bloomBitsIndexer.init();
    await this.bcMonitor.init(this.latestBlock.header);
    this.initOver();
  }

  start() {
    this.sync.start();
    this.txPool.start();
    this.txSync.start();
    this.bloomBitsIndexer.start();
    this.networkMngr.start();
    const latest = this.latestBlock;
    const number = latest.header.number;
    this.evpool.start(number);

    this.pendingTxsLoopPromise = this.pendingTxsLoop();
    this.commitBlockLoopPromise = this.commitBlockLoop();

    // start mint
    this.getCurrentEngine().start();
    this.getCurrentEngine().newBlock(latest);
  }

  /**
   * Abort node
   */
  async abort() {
    this.sync.off('synchronized', this.onSyncOver);
    this.sync.off('failed', this.onSyncOver);
    this.networkMngr.off('installed', this.onPeerInstalled);
    this.networkMngr.off('removed', this.onPeerRemoved);
    this.pendingTxsQueue.abort();
    this.commitBlockQueue.abort();
    await this.aborter.abort();
    await this.master.abort();
    await this.clique.abort();
    await this.reimint.abort();
    await this.networkMngr.abort();
    await this.sync.abort();
    await this.txPool.abort();
    this.txSync.abort();
    await this.bloomBitsIndexer.abort();
    await this.pendingTxsLoopPromise;
    await this.commitBlockLoopPromise;
    await this.evidencedb.close();
    await this.nodedb.close();
    await this.networkdb.close();
  }

  private onPeerInstalled = (name: string, peer: Peer) => {
    if (name === this.wire.name) {
      const handler = this.wire.getHandler(peer, false);
      handler && this.sync.announce(handler);
    }
  };

  private onPeerRemoved = (peer: Peer) => {
    this.txSync.dropPeer(peer.peerId);
  };

  private onSyncOver = () => {
    this.getCurrentEngine().newBlock(this.latestBlock);
  };

  /**
   * Mint over callback,
   * it will be called when local node mint a block,
   * it will try to continue mint a new block after the latest block
   */
  onMintBlock() {
    this.getCurrentEngine().newBlock(this.latestBlock);
  }

  /**
   * Get common object by block number
   * @param num - Block number
   * @returns Common object
   */
  getCommon(num: BNLike) {
    return Common.createCommonByBlockNumber(num, this.chain);
  }

  /**
   * Get latest block common instance
   * @returns Common object
   */
  getLatestCommon() {
    return this.latestBlock._common;
  }

  getLatestBlock() {
    return this.latestBlock;
  }

  getTotalDifficulty() {
    return this.totalDifficulty.clone();
  }

  /**
   * Get consensus engine by consensus typo
   * @param type - Consensus type
   * @returns Consensus engine
   */
  getEngineByType(type: ConsensusType): ConsensusEngine {
    if (type === ConsensusType.Clique) {
      return this.clique;
    } else if (type === ConsensusType.Reimint) {
      return this.reimint;
    } else {
      throw new Error('unknown consensus type:' + type);
    }
  }

  /**
   * Get consensus engine by common instance
   * @param common - Common instance
   * @returns Consensus engine
   */
  getEngineByCommon(common: Common) {
    return this.getEngineByType(getConsensusTypeByCommon(common))!;
  }

  /**
   * Get current working consensus engine
   * @returns Consensus engine
   */
  getCurrentEngine() {
    const nextCommon = this.getCommon(this.latestBlock.header.number.addn(1));
    return this.getEngineByType(getConsensusTypeByCommon(nextCommon))!;
  }

  /**
   * Get state manager object by state root
   * @param root - State root
   * @param num - Block number or Common
   * @returns State manager object
   */
  async getStateManager(root: Buffer, num: BNLike | Common) {
    const stateManager = new StateManager({ common: num instanceof Common ? num : this.getCommon(num), trie: new Trie(this.master) });
    await stateManager.setStateRoot(root);
    return stateManager;
  }

  /**
   * Get a VM object by state root
   * @param root - The state root
   * @param num - Block number or Common
   * @returns VM object
   */
  async getVM(root: Buffer, num: BNLike | Common) {
    const stateManager = await this.getStateManager(root, num);
    const common = stateManager._common;
    const genesisBlock = Block.fromBlockData({ header: common.genesis() }, { common });
    return new VM({
      common,
      stateManager,
      blockchain: new Blockchain({
        dbManager: this.db,
        common,
        genesisBlock,
        validateBlocks: false,
        validateConsensus: false,
        hardforkByHeadBlockNumber: true
      }),
      getMiner: (header) => {
        const type = getConsensusTypeByCommon(header._common);
        if (type === ConsensusType.Clique) {
          return header.cliqueSigner();
        } else if (type === ConsensusType.Reimint) {
          if (header.extraData.length === CLIQUE_EXTRA_VANITY) {
            return EMPTY_ADDRESS;
          } else {
            return ExtraData.fromBlockHeader(header).proposal.proposer();
          }
        } else {
          throw new Error('unknow consensus type');
        }
      }
    });
  }

  /**
   * Get stake manager contract object
   * @param vm - Target vm instance
   * @param block - Target block
   * @param common - Common instance
   * @returns Stake manager contract object
   */
  getStakeManager(vm: VM, block: Block, common?: Common) {
    const evm = new EVM(vm, new TxContext(new BN(0), EMPTY_ADDRESS), block);
    return new StakeManager(evm, common ?? block._common);
  }

  /**
   * Create a new bloom filter
   * @returns Bloom filter object
   */
  getFilter() {
    return new BloomBitsFilter({ node: this, sectionSize: BloomBitsBlocks });
  }

  /**
   * Get chain id
   * @returns Chain id
   */
  getChainId() {
    return this.chainId;
  }

  /**
   * Get current pending block,
   * if current pending block doesn't exsit,
   * it will return an empty block
   * @returns Pending block
   */
  getPendingBlock() {
    const engine = this.getCurrentEngine();
    const pendingBlock = engine.worker.getPendingBlock();
    const lastest = this.latestBlock;
    if (pendingBlock) {
      const { header, transactions } = pendingBlock.makeBlockData();
      header.stateRoot = header.stateRoot ?? lastest.header.stateRoot;
      return engine.generatePendingBlock(header, pendingBlock.common, transactions);
    } else {
      const nextNumber = lastest.header.number.addn(1);
      return engine.generatePendingBlock(
        {
          parentHash: lastest.hash(),
          stateRoot: lastest.header.stateRoot,
          number: nextNumber
        },
        this.getCommon(nextNumber)
      );
    }
  }

  /**
   * Get pending state manager instance
   * @returns State manager instance
   */
  getPendingStateManager() {
    const engine = this.getCurrentEngine();
    const pendingBlock = engine.worker.getPendingBlock();
    if (pendingBlock) {
      return this.getStateManager(pendingBlock.pendingStateRoot, pendingBlock.common);
    } else {
      const latest = this.latestBlock;
      return this.getStateManager(latest.header.stateRoot, latest._common);
    }
  }

  /**
   * A loop that executes blocks sequentially
   */
  private async commitBlockLoop() {
    await this.initPromise;
    for await (const {
      options: { block, receipts, broadcast },
      resolve,
      reject
    } of this.commitBlockQueue.generator()) {
      try {
        const { reorged } = await this.master.commitBlock({ block, receipts });

        // if canonical chain changes, notify to other modules
        if (reorged) {
          // update the latest block and total difficulty
          this.latestBlock = await this.master.latestBlock();
          this.totalDifficulty = await this.master.totalDifficulty(this.latestBlock.hash(), this.latestBlock.header.number);

          const promises = [this.txPool.newBlock(block), this.bcMonitor.newBlock(block), this.bloomBitsIndexer.newBlockHeader(block.header)];
          if (isEnableRemint(block._common)) {
            const extraData = ExtraData.fromBlockHeader(block.header);
            this.evpool.update(extraData.evidence, block.header.number);
          }

          if (broadcast) {
            promises.push(this.wire.broadcastNewBlock(block));
          }

          await Promise.all(promises);
        }

        resolve(reorged);
      } catch (err) {
        reject(err);
      }
    }
  }

  /**
   * A loop that adds pending transaction
   */
  private async pendingTxsLoop() {
    await this.initPromise;
    for await (const task of this.pendingTxsQueue.generator()) {
      try {
        const { results, readies } = await this.txPool.addTxs(task.txs);
        if (readies && readies.size > 0) {
          const hashes = Array.from(readies.values())
            .reduce((a, b) => a.concat(b), [])
            .map((tx) => tx.hash());
          for (const handler of this.wire.pool.handlers) {
            handler.announceTx(hashes);
          }
          await this.getCurrentEngine().addTxs(readies);
        }
        task.resolve(results);
      } catch (err) {
        task.resolve(new Array<boolean>(task.txs.length).fill(false));
        logger.error('Node::taskLoop, catch error:', err);
      }
    }
  }

  /**
   * Push a block to the commit block queue
   * @param options - Commit block options
   * @returns Reorged
   */
  async commitBlock(options: CommitBlockOptions) {
    await this.initPromise;
    return new Promise<boolean>((resolve, reject) => {
      this.commitBlockQueue.push({ options, resolve, reject });
    });
  }

  /**
   * Add pending transactions to consensus engine
   * @param txs - Pending transactions
   * @returns An array of results, one-to-one correspondence with transactions
   */
  async addPendingTxs(txs: Transaction[]) {
    await this.initPromise;
    return new Promise<boolean[]>((resolve) => {
      this.pendingTxsQueue.push({ txs, resolve });
    });
  }

  /**
   * Ban peer
   * @param peerId - Target peer
   * @param reason - Ban reason
   */
  async banPeer(peerId: string, reason: 'invalid' | 'timeout') {
    if (reason === 'invalid') {
      await this.networkMngr.ban(peerId, defaultInvalidBanTime);
    } else {
      await this.networkMngr.ban(peerId, defaultTimeoutBanTime);
    }
  }

  /**
   * CheckEvidence takes an array of evidence from a block and verifies all the evidence there
   * @param evList - List of evidence
   */
  async checkEvidence(evList: Evidence[]) {
    await this.evpool.checkEvidence(evList);
  }
}
