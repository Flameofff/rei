import { Address, BN, intToBuffer, ecsign, bufferToHex } from 'ethereumjs-util';
import { Channel, logger } from '@gxchain2/utils';
import { Block, BlockHeader } from '@gxchain2/structure';
import { EventEmitter } from 'events';
import { Node } from '../../node';
import { ValidatorSet } from '../../staking';
import { HeightVoteSet, Vote, VoteType, ConflictingVotesError } from './vote';
import { TimeoutTicker } from './timeoutTicker';
import { ReimintConsensusEngine } from './reimint';
import { Block_hash, BlockHeader_hash } from './extraData';
import { isEmptyHash, EMPTY_HASH } from './utils';
import { Proposal } from './proposal';
import { Message, NewRoundStepMessage, NewValidBlockMessage, VoteMessage, ProposalBlockMessage, GetProposalBlockMessage, ProposalMessage, HasVoteMessage } from './messages';

export interface Signer {
  address(): Address;
  sign(msg: Buffer): Buffer;
}

export interface EvidencePool {
  reportConflictingVotes(voteA: Vote, voteB: Vote);
}

/////////////////////// mock ///////////////////////

export class MockEvidencePool implements EvidencePool {
  reportConflictingVotes(voteA: Vote, voteB: Vote) {
    logger.debug('receive evidence:', voteA, voteB);
  }
}

export class MockSigner implements Signer {
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }

  address(): Address {
    return this.node.getLastestEngine().coinbase;
  }

  sign(msg: Buffer): Buffer {
    const coinbase = this.node.getLastestEngine().coinbase;
    if (coinbase.equals(Address.zero())) {
      throw new Error('empty coinbase');
    }
    const signature = ecsign(msg, this.node.accMngr.getPrivateKey(coinbase));
    return Buffer.concat([signature.r, signature.s, intToBuffer(signature.v - 27)]);
  }
}

/////////////////////// mock ///////////////////////

export enum RoundStepType {
  NewHeight = 1,
  NewRound,
  Propose,
  Prevote,
  PrevoteWait,
  Precommit,
  PrecommitWait,
  Commit
}

export type StateMachineMessage = MessageInfo | TimeoutInfo;

export type MessageInfo = {
  peerId: string;
  msg: Message;
};

export type TimeoutInfo = {
  duration: number;
  height: BN;
  round: number;
  step: RoundStepType;
};

function isMessageInfo(smsg: StateMachineMessage): smsg is MessageInfo {
  return 'peerId' in smsg;
}

/////////////////////// config ///////////////////////

const SkipTimeoutCommit = true;
const WaitForTxs = true;
const CreateEmptyBlocksInterval = 0;
const StateMachineMsgQueueMaxSize = 10;

// TODO: config
function proposeDuration(round: number) {
  return 40 + 1 * round;
}

function prevoteDuration(round: number) {
  return 10 + 1 * round;
}

function precommitDutaion(round: number) {
  return 10 + 1 * round;
}

function commitTimeout(time: number) {
  return 10 + time;
}

/////////////////////// config ///////////////////////

export class StateMachine extends EventEmitter {
  private readonly node: Node;
  // TODO:
  private readonly signer?: Signer;
  // TODO:
  private readonly evpool: EvidencePool;
  private readonly timeoutTicker = new TimeoutTicker((ti) => {
    this.msgQueue.push(ti);
  });

  private msgLoopPromise?: Promise<void>;
  private readonly msgQueue = new Channel<StateMachineMessage>({
    max: StateMachineMsgQueueMaxSize,
    drop: (smsg) => {
      logger.warn('StateMachine::drop, too many messages, drop:', smsg);
    }
  });

  // statsMsgQueue = new Channel<any>();

  private readonly engine: ReimintConsensusEngine;
  private parentHash!: Buffer;
  private triggeredTimeoutPrecommit: boolean = false;

  /////////////// RoundState ///////////////
  private height: BN = new BN(0);
  private round: number = 0;
  private step: RoundStepType = RoundStepType.NewHeight;
  private startTime!: number;

  private commitTime?: number;
  private validators!: ValidatorSet;
  private proposal?: Proposal;
  private proposalBlockHash?: Buffer;
  private proposalBlock?: Block;

  private lockedRound: number = -1;
  private lockedBlock?: Block;

  private validRound: number = -1;
  private validBlock?: Block;

  private votes!: HeightVoteSet;
  private commitRound: number = -1;
  /////////////// RoundState ///////////////

  constructor(node: Node, engine: ReimintConsensusEngine, signer?: Signer) {
    super();
    this.node = node;
    this.engine = engine;
    this.evpool = new MockEvidencePool();
    this.signer = signer ?? (this.engine.coinbase.equals(Address.zero()) ? undefined : new MockSigner(node));
  }

  private newStep(timestamp?: number) {
    this.emit('newStep', new NewRoundStepMessage(this.height, this.round, this.step, (timestamp ?? Date.now()) - this.startTime, 0));
  }

  async msgLoop() {
    for await (const smsg of this.msgQueue.generator()) {
      try {
        if (isMessageInfo(smsg)) {
          this.handleMsg(smsg);
        } else {
          this.handleTimeout(smsg);
        }
      } catch (err) {
        logger.error('State::msgLoop, catch error:', err);
      }
    }
  }

  private handleMsg(mi: MessageInfo) {
    const { msg, peerId } = mi;

    if (msg instanceof ProposalMessage) {
      this.setProposal(msg.proposal);
    } else if (msg instanceof ProposalBlockMessage) {
      this.addProposalBlock(msg.block);
      // statsMsgQueue <- mi
    } else if (msg instanceof VoteMessage) {
      this.tryAddVote(msg.vote, peerId);
      // statsMsgQueue <- mi
    } else {
      throw new Error('unknown msg type');
    }
  }

  private handleTimeout(ti: TimeoutInfo) {
    if (!ti.height.eq(this.height) || ti.round < this.round || (ti.round === this.round && ti.step < this.step)) {
      logger.debug('StateMachine::handleTimeout, ignoring tock because we are ahead');
      return;
    }

    switch (ti.step) {
      case RoundStepType.NewHeight:
        this.enterNewRound(ti.height, 0);
      case RoundStepType.NewRound:
        this.enterPropose(ti.height, 0);
      case RoundStepType.Propose:
        // TODO: emit a event
        this.enterPrevote(ti.height, ti.round);
      case RoundStepType.PrevoteWait:
        this.enterPrecommit(ti.height, ti.round);
      case RoundStepType.PrecommitWait:
        this.enterPrecommit(ti.height, ti.round);
        this.enterNewRound(ti.height, ti.round + 1);
      default:
        throw new Error('invalid timeout step');
    }
  }

  // private handleTxsAvailable() {}

  private setProposal(proposal: Proposal) {
    if (this.proposal) {
      return;
    }

    if (!this.height.eq(proposal.height) || this.round !== proposal.round) {
      return;
    }

    if (proposal.POLRound < -1 || (proposal.POLRound >= 0 && proposal.POLRound >= proposal.round)) {
      throw new Error('invalid proposal POL round');
    }

    proposal.validateSignature(this.validators.proposer());

    this.proposal = proposal;
    this.proposalBlockHash = proposal.hash;
    if (this.proposalBlock === undefined) {
      this.emit('getProposalBlock', new GetProposalBlockMessage(proposal.hash));
    }
  }

  private isProposalComplete() {
    if (this.proposal === undefined || this.proposalBlock === undefined) {
      return false;
    }

    if (this.proposal.POLRound < 0) {
      return true;
    }

    return !!this.votes.prevotes(this.proposal.POLRound)?.hasTwoThirdsMajority();
  }

  private addProposalBlock(block: Block) {
    if (this.proposalBlock) {
      return;
    }
    if (this.proposalBlockHash === undefined) {
      throw new Error('add proposal block when hash is undefined');
    }
    if (!this.proposalBlockHash.equals(Block_hash(block))) {
      throw new Error('invalid proposal block');
    }
    // TODO: validate block?
    this.proposalBlock = block;
    const prevotes = this.votes.prevotes(this.round);
    const maj23Hash = prevotes?.maj23;
    if (maj23Hash && !isEmptyHash(maj23Hash) && this.validRound < this.round) {
      if (this.proposalBlockHash.equals(maj23Hash)) {
        logger.debug('StateMachine::addProposalBlock, update valid block, round:', this.round, 'hash:', bufferToHex(maj23Hash));

        this.validRound = this.round;
        this.validBlock = this.proposalBlock;
      }
    }

    if (this.step <= RoundStepType.Propose && this.isProposalComplete()) {
      this.enterPrevote(this.height, this.round);
      if (maj23Hash) {
        this.enterPrecommit(this.height, this.round);
      }
    } else if (this.step === RoundStepType.Commit) {
      this.tryFinalizeCommit(this.height);
    }
  }

  private addVote(vote: Vote, peerId: string) {
    logger.debug('StateMachine::addVote');

    if (!vote.height.eq(vote.height)) {
      logger.debug('StateMachine::addVote, unequal height, ignore, vote:', vote.height.toString(), 'state machine:', this.height.toString());
      return;
    }

    this.votes.addVote(vote, peerId);
    // TODO: if add failed, return

    // emit hasVote event
    this.emit('hasVote', new HasVoteMessage(vote.height, vote.round, vote.type, vote.index));

    switch (vote.type) {
      case VoteType.Prevote: {
        const prevotes = this.votes.prevotes(vote.round);
        const maj23Hash = prevotes?.maj23;
        if (maj23Hash) {
          // try to unlock ourself
          if (this.lockedBlock !== undefined && this.lockedRound < vote.round && vote.round <= this.round && !Block_hash(this.lockedBlock).equals(maj23Hash)) {
            this.lockedRound = -1;
            this.lockedBlock = undefined;

            // TODO: emit unlock event
          }

          // try to update valid block
          if (!isEmptyHash(maj23Hash) && this.validRound < vote.round && vote.round === this.round) {
            if (this.proposalBlockHash && this.proposalBlockHash.equals(maj23Hash)) {
              logger.debug('StateMachine::addVote, update valid block, round:', this.round, 'hash:', bufferToHex(maj23Hash));

              this.validRound = vote.round;
              this.validBlock = this.proposalBlock;
            } else {
              this.proposalBlock = undefined;
            }

            if (!this.proposalBlockHash || !this.proposalBlockHash.equals(maj23Hash)) {
              this.proposalBlockHash = maj23Hash;
            }

            this.emit('newValidBlock', new NewValidBlockMessage(this.height, this.round, this.proposalBlockHash, this.step === RoundStepType.Commit));
          }
        }

        if (this.round < vote.round && prevotes?.hasTwoThirdsAny()) {
          this.enterNewRound(this.height, vote.round);
        } else if (this.round === vote.round && RoundStepType.Prevote <= this.step) {
          if (maj23Hash && (this.isProposalComplete() || isEmptyHash(maj23Hash))) {
            this.enterPrecommit(this.height, vote.round);
          } else if (prevotes?.hasTwoThirdsAny()) {
            this.enterPrevoteWait(this.height, vote.round);
          }
        } else if (this.proposal !== undefined && 0 <= this.proposal.POLRound && this.proposal.POLRound === vote.round) {
          if (this.isProposalComplete()) {
            this.enterPrevote(this.height, this.round);
          }
        }
      }
      case VoteType.Precommit: {
        const precommits = this.votes.precommits(vote.round);
        const maj23Hash = precommits?.maj23;
        if (maj23Hash) {
          this.enterNewRound(this.height, vote.round);
          this.enterPrecommit(this.height, vote.round);

          if (!isEmptyHash(maj23Hash)) {
            this.enterCommit(this.height, vote.round);
            if (SkipTimeoutCommit) {
              this.enterNewRound(this.height, 0);
            }
          } else {
            this.enterPrecommitWait(this.height, vote.round);
          }
        } else if (this.round <= vote.round && precommits?.hasTwoThirdsAny()) {
          this.enterNewRound(this.height, vote.round);
          this.enterPrecommitWait(this.height, vote.round);
        }
      }
      default:
        throw new Error('unexpected vote type');
    }
  }

  private tryAddVote(vote: Vote, peerId: string) {
    try {
      this.addVote(vote, peerId);
    } catch (err) {
      if (err instanceof ConflictingVotesError) {
        // if (!this.signer) {
        //   return;
        // }
        if (this.signer && vote.validator().equals(this.signer.address())) {
          // found conflicting vote from ourselves
          return;
        }
        const { voteA, voteB } = err;
        this.evpool.reportConflictingVotes(voteA, voteB);
      } else {
        logger.warn('StateMachine::tryAddVote, catch error:', err);
      }
    }
  }

  private enterNewRound(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && this.step !== RoundStepType.NewHeight)) {
      logger.debug('StateMachine::enterNewRound, invalid args');
      return;
    }

    if (this.startTime > Date.now()) {
      logger.debug('...?');
    }

    let validators = this.validators;
    if (this.round < round) {
      validators = validators.copy();
      validators.incrementProposerPriority(round - this.round);
    }

    this.round = round;
    this.step = RoundStepType.NewRound;
    this.validators = validators;
    if (round === 0) {
      // do nothing
    } else {
      this.proposal = undefined;
      this.proposalBlock = undefined;
      this.proposalBlockHash = undefined;
    }

    this.votes.setRound(round + 1);
    this.triggeredTimeoutPrecommit = false;

    const waitForTxs = WaitForTxs && round === 0;
    if (waitForTxs) {
      if (CreateEmptyBlocksInterval > 0) {
        this.timeoutTicker.schedule({
          duration: CreateEmptyBlocksInterval,
          step: RoundStepType.NewRound,
          height: height.clone(),
          round
        });
      }
    } else {
      this.enterPropose(height, round);
    }
  }

  private createBlockAndProposal() {
    const pendingBlock = (this.engine as any).worker.directlyGetPendingBlockByParentHash(this.parentHash);
    if (!pendingBlock) {
      throw new Error('missing pending block');
    }
    return this.engine.generateBlockAndProposal({ ...pendingBlock.header }, [...pendingBlock.transactions], { common: pendingBlock._common, round: this.round, POLRound: this.validRound, validatorSetSize: this.validators.length }) as { block: Block; proposal: Proposal };
  }

  private decideProposal(height: BN, round: number) {
    let block: Block;
    let proposal: Proposal;

    if (this.validBlock) {
      block = this.validBlock;
      proposal = new Proposal({
        type: VoteType.Proposal,
        height,
        round,
        hash: Block_hash(block),
        POLRound: this.validRound,
        timestamp: Date.now()
      });
      proposal.signature = this.signer!.sign(proposal.getMessageToSign());
    } else {
      const result = this.createBlockAndProposal();
      block = result.block;
      proposal = result.proposal;
    }

    this.msgQueue.push({
      msg: new ProposalMessage(proposal),
      peerId: ''
    });
    this.msgQueue.push({
      msg: new ProposalBlockMessage(block),
      peerId: ''
    });
  }

  private signVote(type: VoteType, hash: Buffer) {
    if (!this.signer) {
      return;
    }

    const index = this.validators.getIndexByAddress(this.signer.address());
    if (index === undefined) {
      return;
    }

    const vote = new Vote({
      chainId: this.node.getChainId(),
      type,
      height: this.height,
      round: this.round,
      timestamp: 1,
      hash,
      index
    });
    vote.signature = this.signer.sign(vote.getMessageToSign());
    this.msgQueue.push({
      msg: new VoteMessage(vote),
      peerId: ''
    });
    return vote;
  }

  private enterPropose(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && RoundStepType.Propose <= this.step)) {
      logger.debug('StateMachine::enterProposal, invalid args');
      return;
    }

    const update = () => {
      this.round = round;
      this.step = RoundStepType.Propose;
      this.newStep();

      if (this.isProposalComplete()) {
        this.enterPrevote(height, round);
      }
    };

    this.timeoutTicker.schedule({
      duration: proposeDuration(round),
      step: RoundStepType.Propose,
      height: height.clone(),
      round
    });

    if (!this.signer) {
      return update();
    }

    if (!this.validators.proposer().equals(this.signer.address())) {
      return update();
    }

    this.decideProposal(height, round);
    return update();
  }

  private enterPrevote(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && RoundStepType.Prevote <= this.step)) {
      logger.debug('StateMachine::enterPrevote, invalid args');
      return;
    }

    const update = () => {
      this.round = round;
      this.step = RoundStepType.Prevote;
      this.newStep();
    };

    if (this.lockedBlock) {
      this.signVote(VoteType.Prevote, Block_hash(this.lockedBlock));
      return update();
    }

    if (this.proposalBlock === undefined) {
      this.signVote(VoteType.Prevote, EMPTY_HASH);
      return update();
    }

    // TODO: validate block
    const validate = 1;
    if (validate) {
      this.signVote(VoteType.Prevote, Block_hash(this.proposalBlock));
    } else {
      this.signVote(VoteType.Prevote, EMPTY_HASH);
    }
    return update();
  }

  private enterPrevoteWait(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && RoundStepType.PrevoteWait <= this.step)) {
      logger.debug('StateMachine::enterPrevoteWait, invalid args');
      return;
    }

    if (!this.votes.prevotes(round)?.hasTwoThirdsAny()) {
      throw new Error("enterPrevoteWait doesn't have any +2/3 votes");
    }

    const update = () => {
      this.round = round;
      this.step = RoundStepType.PrevoteWait;
      this.newStep();
    };

    this.timeoutTicker.schedule({
      duration: prevoteDuration(round),
      step: RoundStepType.PrevoteWait,
      height: height.clone(),
      round
    });
    return update();
  }

  private enterPrecommit(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && RoundStepType.Precommit <= this.step)) {
      logger.debug('StateMachine::enterPrecommit, invalid args');
      return;
    }

    const update = () => {
      this.round = round;
      this.step = RoundStepType.Precommit;
      this.newStep();
    };

    const maj23Hash = this.votes.prevotes(round)?.maj23;

    if (!maj23Hash) {
      this.signVote(VoteType.Precommit, EMPTY_HASH);
      return update();
    }

    const polInfo = this.votes.POLInfo();
    if (polInfo && polInfo[0] < round) {
      throw new Error('invalid pol round');
    }

    if (isEmptyHash(maj23Hash)) {
      if (this.lockedBlock === undefined) {
        // do nothing
      } else {
        this.lockedRound = -1;
        this.lockedBlock = undefined;
      }

      this.signVote(VoteType.Precommit, EMPTY_HASH);
      return update();
    }

    if (this.lockedBlock && Block_hash(this.lockedBlock).equals(maj23Hash)) {
      this.lockedRound = round;

      this.signVote(VoteType.Precommit, maj23Hash);
      return update();
    }

    if (this.proposalBlock && Block_hash(this.proposalBlock).equals(maj23Hash)) {
      // validate block

      this.lockedRound = round;
      this.lockedBlock = this.proposalBlock;

      this.signVote(VoteType.Precommit, maj23Hash);
      return update();
    }

    this.lockedRound = -1;
    this.lockedBlock = undefined;

    if (!this.proposalBlock || !Block_hash(this.proposalBlock).equals(maj23Hash)) {
      this.proposalBlock = undefined;
      this.proposalBlockHash = maj23Hash;
    }

    this.signVote(VoteType.Precommit, EMPTY_HASH);
    return update();
  }

  private enterPrecommitWait(height: BN, round: number) {
    if (!this.height.eq(height) || round < this.round || (this.round === round && this.triggeredTimeoutPrecommit)) {
      logger.debug('StateMachine::enterPrecommitWait, invalid args');
      return;
    }

    if (!this.votes.precommits(round)?.hasTwoThirdsAny()) {
      throw new Error("enterPrecommitWait doesn't have any +2/3 votes");
    }

    const update = () => {
      this.triggeredTimeoutPrecommit = true;
      this.newStep();
    };

    this.timeoutTicker.schedule({
      duration: precommitDutaion(round),
      step: RoundStepType.PrecommitWait,
      height: height.clone(),
      round
    });
    return update();
  }

  private enterCommit(height: BN, commitRound: number) {
    if (!this.height.eq(height) || RoundStepType.Commit <= this.step) {
      logger.debug('StateMachine::enterCommit, invalid args');
      return;
    }

    const update = () => {
      this.step = RoundStepType.Commit;
      this.commitRound = commitRound;
      this.commitTime = Date.now();
      this.newStep();

      this.tryFinalizeCommit(height);
    };

    const maj23Hash = this.votes.precommits(commitRound)?.maj23;
    if (!maj23Hash) {
      throw new Error('enterCommit expected +2/3 precommits');
    }
    if (this.lockedBlock) {
      const lockedHash = Block_hash(this.lockedBlock);
      if (lockedHash.equals(maj23Hash)) {
        this.proposalBlockHash = Block_hash(this.lockedBlock);
        this.proposalBlock = this.lockedBlock;
      }
    }

    if (!this.proposalBlock || !Block_hash(this.proposalBlock).equals(maj23Hash)) {
      this.proposalBlock = undefined;
      this.proposalBlockHash = maj23Hash;
    }

    return update();
  }

  private tryFinalizeCommit(height: BN) {
    if (!this.height.eq(height) || this.step !== RoundStepType.Commit) {
      throw new Error('tryFinalizeCommit invalid args');
    }

    const maj23Hash = this.votes.precommits(this.commitRound)?.maj23;
    if (!maj23Hash || isEmptyHash(maj23Hash)) {
      return;
    }

    if (!this.proposalBlock || !Block_hash(this.proposalBlock).equals(maj23Hash)) {
      return;
    }

    // TODO: validate proposalBlock
    // TODO: save seenCommit

    const finalizedBlock = this.proposalBlock;
    this.node
      .processBlock(finalizedBlock, { generate: true, broadcast: true })
      .then(() => {
        logger.debug('StateMachine::tryFinalizeCommit, mint a block');
      })
      .catch((err) => {
        logger.error('StateMachine::tryFinalizeCommit, catch error:', err);
      });
  }

  start() {
    if (this.msgLoopPromise) {
      throw new Error('msg loop has started');
    }
    this.msgLoopPromise = this.msgLoop();
  }

  async abort() {
    if (this.msgLoopPromise) {
      this.msgQueue.abort();
      await this.msgLoopPromise;
      this.msgQueue.reset();
      this.msgLoopPromise = undefined;
    }
  }

  newMessage(smsg: StateMachineMessage) {
    this.msgQueue.push(smsg);
  }

  newBlockHeader(header: BlockHeader, validators: ValidatorSet) {
    // TODO: pretty this
    if (this.commitRound > -1 && this.height.gtn(0) && !this.height.eq(header.number)) {
      throw new Error('newBlockHeader invalid args');
    }

    const timestamp = Date.now();
    this.parentHash = BlockHeader_hash(header);
    this.height = header.number.addn(1);
    this.round = 0;
    this.step = RoundStepType.NewHeight;
    this.startTime = commitTimeout(this.commitTime ?? timestamp);
    this.validators = validators;
    this.proposal = undefined;
    this.proposalBlock = undefined;
    this.lockedRound = -1;
    this.lockedBlock = undefined;
    this.validRound = -1;
    this.validBlock = undefined;
    this.votes = new HeightVoteSet(this.node.getChainId(), this.height, this.validators);
    this.commitRound = -1;
    this.triggeredTimeoutPrecommit = false;

    this.newStep(timestamp);

    this.timeoutTicker.schedule({
      duration: this.startTime - Date.now(),
      step: RoundStepType.NewHeight,
      height: this.height.clone(),
      round: 0
    });
  }
}