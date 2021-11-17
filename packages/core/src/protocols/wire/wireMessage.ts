import { rlp, BN, bnToUnpaddedBuffer, intToBuffer, bufferToInt } from 'ethereumjs-util';
import { mustParseTransction, Transaction, Block, BlockHeader, BlockHeaderBuffer, TransactionsBuffer, BlockOptions, TxOptions } from '@gxchain2/structure';
import { NodeStatus } from '../..';

const maxTxPacketSize = 102400;

export const maxGetBlockHeaders = 128;
export const maxTxRetrievals = 256;

export interface WireMessage {
  response?: number;
  raw(): any;
  serialize(): Buffer;
  validateBasic(): void;
}

export class StatusMessage implements WireMessage {
  readonly data: NodeStatus;

  constructor(data: NodeStatus) {
    this.data = data;
    this.validateBasic();
  }

  static readonly code = 0;

  static fromValuesArray(values: Buffer[]) {
    if (values.length !== 5) {
      throw new Error('invalid values');
    }

    const [networkIdBuffer, totalDifficulty, heightBuffer, bestHash, genesisHash] = values;
    const data = {
      networkId: bufferToInt(networkIdBuffer),
      totalDifficulty: totalDifficulty,
      height: bufferToInt(heightBuffer),
      bestHash: bestHash,
      genesisHash: genesisHash
    };
    return new StatusMessage(data);
  }

  raw() {
    return [intToBuffer(this.data.networkId), this.data.totalDifficulty, intToBuffer(this.data.height), this.data.bestHash, this.data.genesisHash];
  }

  serialize() {
    return rlp.encode(this.raw());
  }
  validateBasic() {}
}

export class GetBlockHeadersMessage implements WireMessage {
  readonly start: number;
  readonly count: number;

  constructor(start: number, count: number) {
    this.start = start;
    this.count = count;
    this.validateBasic();
  }

  static readonly code = 1;
  static readonly response = 2;

  static fromValuesArray(values: Buffer[]) {
    if (values.length !== 2) {
      throw new Error('invalid values');
    }

    const [start, count] = values;
    return new GetBlockHeadersMessage(bufferToInt(start), bufferToInt(count));
  }

  raw() {
    return [intToBuffer(this.start), intToBuffer(this.count)];
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {
    if (this.count > maxGetBlockHeaders) {
      throw new Error('invaild count');
    }
  }
}

export class BlockHeadersMessage implements WireMessage {
  readonly rawHeaders: BlockHeaderBuffer[];

  constructor(b: BlockHeaderBuffer[]) {
    this.rawHeaders = b;
    this.validateBasic();
  }

  static readonly code = 2;

  static fromValuesArray(values: BlockHeaderBuffer[]) {
    return new BlockHeadersMessage(values);
  }

  toBlockHeader(opts?: TxOptions) {
    return this.rawHeaders.map((h) => BlockHeader.fromValuesArray(h, opts));
  }

  raw() {
    return this.rawHeaders;
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {}
}

export class GetBlockBodiesMessage implements WireMessage {
  readonly headerHashs: Buffer[];

  constructor(headerHashs: Buffer[]) {
    this.headerHashs = headerHashs;
    this.validateBasic();
  }

  static readonly code = 3;
  static readonly response = 4;

  static fromValuesArray(values: Buffer[]) {
    return new GetBlockBodiesMessage(values);
  }

  raw() {
    return this.headerHashs;
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {
    if (this.headerHashs.length > maxGetBlockHeaders) {
      throw new Error('invaild hashes count');
    }
  }
}

export class BlockBodiesMessage implements WireMessage {
  readonly bodies: Transaction[][];

  constructor(bodies: Transaction[][]) {
    this.bodies = bodies;
    this.validateBasic();
  }

  static readonly code = 4;

  static fromValuesArray(values: TransactionsBuffer[], opts?: TxOptions) {
    const bodies = values.map((txs) => {
      return txs.map((tx) => mustParseTransction(tx, opts));
    });
    return new BlockBodiesMessage(bodies);
  }

  raw() {
    return this.bodies.map((txs) => {
      return txs.map((tx) => tx.raw() as Buffer[]);
    });
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {}
}

export class NewBlockMessage implements WireMessage {
  readonly block: Block;
  readonly td: BN;

  constructor(block: Block, td: BN) {
    this.block = block;
    this.td = td;
    this.validateBasic();
  }

  static readonly code = 5;

  static fromValuesArray(values: any, opts?: BlockOptions) {
    if (values.length !== 2) {
      throw new Error('invalid values');
    }

    const block = Block.fromValuesArray(values[0], opts);
    const td = new BN(values[1]);
    return new NewBlockMessage(block, td);
  }

  raw() {
    return [[this.block.header.raw(), this.block.transactions.map((tx) => tx.raw() as Buffer[])], bnToUnpaddedBuffer(this.td)];
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {}
}

export class NewPooledTransactionHashesMessage implements WireMessage {
  readonly hashes: Buffer[];

  constructor(hashes: Buffer[]) {
    this.hashes = hashes;
    this.validateBasic();
  }

  static readonly code = 6;

  static fromValuesArray(values: Buffer[]) {
    return new NewPooledTransactionHashesMessage(values);
  }

  raw() {
    return [...this.hashes];
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {
    if (this.hashes.length > maxTxPacketSize) {
      throw new Error('invaild hashes count');
    }
  }
}

export class GetPooledTransactionsMessage implements WireMessage {
  readonly hashes: Buffer[];

  constructor(hashes: Buffer[]) {
    this.hashes = hashes;
    this.validateBasic();
  }

  static readonly code = 7;
  static readonly response = 8;

  static fromValuesArray(values: Buffer[]) {
    return new GetPooledTransactionsMessage(values);
  }

  raw() {
    return [...this.hashes];
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {
    if (this.hashes.length > maxTxRetrievals) {
      throw new Error('invaild hashes count');
    }
  }
}

export class PooledTransactionsMessage implements WireMessage {
  readonly txs: Transaction[];

  constructor(txs: Transaction[]) {
    this.txs = txs;
    this.validateBasic();
  }

  static readonly code = 8;

  static fromValuesArray(values: TransactionsBuffer, opts?: TxOptions) {
    const txs = values.map((tx) => mustParseTransction(tx, opts));
    return new PooledTransactionsMessage(txs);
  }

  raw() {
    return this.txs.map((tx) => tx.raw() as Buffer[]);
  }

  serialize() {
    return rlp.encode(this.raw());
  }

  validateBasic() {}
}
