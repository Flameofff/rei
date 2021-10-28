import { Address, BN, toBuffer, setLengthLeft } from 'ethereumjs-util';
import { Block, BlockHeader, HeaderData, CLIQUE_EXTRA_VANITY, TypedTransaction, BlockOptions, Transaction } from '@gxchain2/structure';
import { Common } from '@gxchain2/common';
import { logger } from '@gxchain2/utils';
import { ConsensusEngine, ConsensusEngineOptions } from '../consensusEngine';
import { EMPTY_ADDRESS, EMPTY_EXTRA_DATA } from '../utils';
import { ConsensusEngineBase } from '../consensusEngineBase';
import { ExtraData, calcBlockHeaderHash } from './extraData';
import { Proposal } from './proposal';
import { StateMachine } from './state';
import { VoteType, VoteSet } from './vote';
import { Evidence } from './evidence';
import { EvidencePool } from './evpool';
import { EvidenceDatabase } from './evdb';

const defaultRound = 0;
const defaultPOLRound = -1;
const defaultProposalTimestamp = 0;
const defaultValidaterSetSize = 1;
const defaultEvidence = [];

function formatHeaderData(data?: HeaderData) {
  if (data) {
    if (data.extraData) {
      const extraData = toBuffer(data.extraData);
      if (extraData.length > CLIQUE_EXTRA_VANITY) {
        data.extraData = extraData.slice(0, CLIQUE_EXTRA_VANITY);
      } else {
        data.extraData = setLengthLeft(extraData, CLIQUE_EXTRA_VANITY);
      }
    } else {
      data.extraData = EMPTY_EXTRA_DATA;
    }
  } else {
    data = { extraData: EMPTY_EXTRA_DATA };
  }
  return data;
}

export interface ReimintBlockOptions extends BlockOptions {
  // whether try to sign the block,
  // default: true
  sign?: boolean;

  // reimint round
  round?: number;

  // POLRound, default: -1
  POLRound?: number;

  // evidence list, default: []
  evidence?: Evidence[];

  // vote set,
  // it must be a precommit vote set
  // and already have `maj23`
  voteSet?: VoteSet;

  // if voteSet is not passed in,
  // validatorSetSize must be passed in,
  // it will be used to determine the size of the validator set
  validatorSetSize?: number;

  // proposal timestamp
  proposalTimestamp?: number;
}

export class ReimintConsensusEngine extends ConsensusEngineBase implements ConsensusEngine {
  readonly state: StateMachine;
  readonly evpool: EvidencePool;

  constructor(options: ConsensusEngineOptions) {
    super(options);
    this.evpool = new EvidencePool(new EvidenceDatabase(options.node.evidencedb));
    this.state = new StateMachine(this);
  }

  /////////////////////////////////

  /**
   * {@link ConsensusEngine.getMiner}
   */
  getMiner(data: BlockHeader | Block): Address {
    const header = data instanceof Block ? data.header : data;
    if (header.extraData.length > CLIQUE_EXTRA_VANITY) {
      return ExtraData.fromBlockHeader(header).proposal.proposer();
    } else {
      return EMPTY_ADDRESS;
    }
  }

  /**
   * {@link ConsensusEngine.simpleSignBlock}
   */
  simpleSignBlock(data: HeaderData, common: Common, transactions?: Transaction[]) {
    const { block } = this.generateBlockAndProposal(data, transactions, { common });
    return block;
  }

  //////////////////////////

  protected _start() {
    logger.debug('ReimintConsensusEngine::_start');
    this.state.start();
  }

  protected async _abort() {
    await this.state.abort();
  }

  /**
   * Process a new block, try to mint a block after this block
   * @param block - New block
   */
  protected async _newBlock(block: Block) {
    const header = block.header;
    // create a new pending block through worker
    const pendingBlock = await this.worker.createPendingBlock(header);
    if (!this.enable || this.node.sync.isSyncing) {
      return;
    }

    const difficulty = new BN(1);
    const gasLimit = this.getGasLimitByCommon(pendingBlock.common);
    pendingBlock.complete(difficulty, gasLimit);

    let validators = this.node.validatorSets.directlyGet(header.stateRoot);
    // if the validator set doesn't exist, return
    if (!validators) {
      const vm = await this.node.getVM(header.stateRoot, header._common);
      validators = await this.node.validatorSets.get(header.stateRoot, this.node.getStakeManager(vm, block, this.node.getCommon(block.header.number.addn(1))));
    }

    this.state.newBlockHeader(header, validators, pendingBlock);
  }

  /**
   * Generate block header, proposal and fill extra data by options
   * @param data - Block header data
   * @param options - Reimint block options
   * @returns Header and proposal
   */
  generateBlockHeaderAndProposal(data?: HeaderData, options?: ReimintBlockOptions): { header: BlockHeader; proposal?: Proposal } {
    const header = BlockHeader.fromHeaderData(data, options);
    const sign = options?.sign ?? true;

    if (sign && this.enable) {
      data = formatHeaderData(data);

      const round = options?.round ?? defaultRound;
      const POLRound = options?.POLRound ?? defaultPOLRound;
      const timestamp = options?.proposalTimestamp ?? defaultProposalTimestamp;
      const validaterSetSize = options?.validatorSetSize ?? defaultValidaterSetSize;
      const evidence = options?.evidence ?? defaultEvidence;

      // calculate block hash
      const headerHash = calcBlockHeaderHash(header, round, POLRound, []);
      const proposal = new Proposal({
        round,
        POLRound,
        height: header.number,
        type: VoteType.Proposal,
        hash: headerHash,
        timestamp
      });
      proposal.sign(this.node.accMngr.getPrivateKey(this.coinbase));
      const extraData = new ExtraData(round, POLRound, evidence, proposal, options?.voteSet);
      return {
        header: BlockHeader.fromHeaderData({ ...data, extraData: Buffer.concat([data.extraData as Buffer, extraData.serialize(validaterSetSize)]) }, options),
        proposal
      };
    } else {
      return { header };
    }
  }

  /**
   * Generate block, proposal and fill extra data by options
   * @param data - Block data
   * @param transactions - Transactions
   * @param options - Reimint block options
   * @returns Block and proposal
   */
  generateBlockAndProposal(data?: HeaderData, transactions?: TypedTransaction[], options?: ReimintBlockOptions): { block: Block; proposal?: Proposal } {
    const { header, proposal } = this.generateBlockHeaderAndProposal(data, options);
    return { block: new Block(header, transactions, undefined, options), proposal };
  }

  /**
   * Generate block for commit
   * @param data - Block header data
   * @param transactions - Transactions
   * @param evidence - Evidence list
   * @param proposal - Proposal
   * @param votes - Precommit vote set
   * @param options - Block options
   * @returns Complete block
   */
  generateFinalizedBlock(data: HeaderData, transactions: TypedTransaction[], evidence: Evidence[], proposal: Proposal, votes: VoteSet, options?: BlockOptions) {
    const extraData = new ExtraData(proposal.round, proposal.POLRound, evidence, proposal, votes);
    data = formatHeaderData(data);
    const header = BlockHeader.fromHeaderData({ ...data, extraData: Buffer.concat([data.extraData as Buffer, extraData.serialize()]) }, options);
    return new Block(header, transactions, undefined, options);
  }
}
