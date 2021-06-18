import { BN } from 'ethereumjs-util';
import { BlockHeader } from '@gxchain2/structure';
import { Channel, logger } from '@gxchain2/utils';
import { Node } from '../node';

export interface ChainIndexerBackend {
  reset(section: BN): void;

  process(header: BlockHeader): void;

  commit(): Promise<void>;

  prune(section: BN): Promise<void>;
}

export interface ChainIndexerOptions {
  node: Node;
  sectionSize: number;
  confirmsBlockNumber: number;
  backend: ChainIndexerBackend;
}

export class ChainIndexer {
  private readonly sectionSize: number;
  private readonly confirmsBlockNumber: number;
  private readonly backend: ChainIndexerBackend;
  private readonly node: Node;
  private readonly initPromise: Promise<void>;
  private readonly processHeaderLoopPromise: Promise<void>;
  private readonly headerQueue: Channel<BlockHeader>;

  private storedSections: BN | undefined;

  constructor(options: ChainIndexerOptions) {
    this.sectionSize = options.sectionSize;
    this.confirmsBlockNumber = options.confirmsBlockNumber;
    this.backend = options.backend;
    this.node = options.node;
    this.initPromise = this.init();
    this.headerQueue = new Channel<BlockHeader>({ max: 1 });
    this.processHeaderLoopPromise = this.processHeaderLoop();
  }

  async init() {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.storedSections = await this.node.db.getStoredSectionCount();
  }

  async abort() {
    this.headerQueue.abort();
    await this.processHeaderLoop;
  }

  async newBlockHeader(header: BlockHeader) {
    await this.initPromise;
    this.headerQueue.push(header);
  }

  private async processHeaderLoop() {
    await this.initPromise;
    let preHeader: BlockHeader | undefined;
    for await (const header of this.headerQueue.generator()) {
      try {
        if (preHeader !== undefined && !header.parentHash.equals(preHeader.hash())) {
          const ancestor = await this.node.db.findCommonAncestor(header, preHeader);
          await this.newHeader(ancestor.number, true);
        }
        await this.newHeader(header.number, false);
        preHeader = header;
      } catch (err) {
        logger.error('ChainIndexer::processHeaderLoop, catch error:', err);
      }
    }
  }

  private async newHeader(number: BN, reorg: boolean) {
    let confirmedSections: BN | undefined = number.gtn(this.confirmsBlockNumber) ? number.subn(this.confirmsBlockNumber).divn(this.sectionSize) : new BN(0);
    confirmedSections = confirmedSections.gtn(0) ? confirmedSections.subn(1) : undefined;
    if (reorg) {
      if (confirmedSections === undefined) {
        await this.backend.prune(new BN(0));
        this.storedSections = undefined;
      } else if (this.storedSections === undefined || !confirmedSections.eq(this.storedSections)) {
        await this.backend.prune(confirmedSections);
        this.storedSections = confirmedSections.clone();
      }
      await this.node.db.setStoredSectionCount(this.storedSections);
      return;
    }
    if (confirmedSections !== undefined && (this.storedSections === undefined || confirmedSections.gt(this.storedSections))) {
      for (const currentSections = this.storedSections ? this.storedSections.clone() : new BN(0); confirmedSections.gte(currentSections); currentSections.iaddn(1)) {
        this.backend.reset(currentSections);
        let lastHeader = currentSections.gtn(0) ? await this.node.db.getCanonicalHeader(currentSections.muln(this.sectionSize).subn(1)) : undefined;
        // the first header number of the next section.
        const maxNum = currentSections.addn(1).muln(this.sectionSize);
        for (const num = currentSections.muln(this.sectionSize); num.lt(maxNum); num.iaddn(1)) {
          const header = await this.node.db.getCanonicalHeader(num);
          if (lastHeader !== undefined && !header.parentHash.equals(lastHeader.hash())) {
            throw new Error(`parentHash is'not match, last: ${lastHeader.number.toString()}, current: ${header.number.toString()}`);
          }
          await this.backend.process(header);
          lastHeader = header;
        }
        await this.backend.commit();
        // save stored section count.
        await this.node.db.setStoredSectionCount(currentSections);
        this.storedSections = currentSections.clone();
      }
    }
  }
}