import { Address, BN, setLengthLeft, toBuffer } from 'ethereumjs-util';
import { EvmcMessage, EvmcTxContext, EvmcCallKind, evmc_flags, EvmcStatusCode, EvmcResult } from '@gxchain2/evmc';

export function biToAddress(address: bigint) {
  return Address.fromString('0x' + address.toString(16).padStart(40, '0'));
}

export function biToBuffer(value: bigint, length = 32) {
  return setLengthLeft(toBuffer('0x' + value.toString(16)), length);
}

export function addressToBI(address: Address) {
  return bufferToBI(address.toBuffer());
}

export function bufferToBI(value: Buffer) {
  return BigInt(new BN(value).toString());
}

export function bnToBI(bn: BN) {
  return BigInt(bn.toString());
}

export function biToBN(bi: bigint) {
  return new BN(bi.toString());
}

export interface EVMCTxContext {
  txGasPrice: BN;
  txOrigin: Address;
  blockCoinbase: Address;
  blockNumber: BN;
  blockTimestamp: BN;
  blockGasLimit: BN;
  blockDifficulty: BN;
  chainId: number;
}

export interface EVMCMessage {
  gas: BN;
  nonce?: BN;
  isStatic: boolean;
  depth: number;
  sender: Address;
  destination?: Address;
  inputData: Buffer;
  value: BN;
  kind: EvmcCallKind;
}

export interface EVMCResult {
  gasLeft?: BN;
  statusCode: EvmcStatusCode;
  outputData?: Buffer;
  createAddress?: Address;
}

export function toEvmcTxContext(ctx: EVMCTxContext): EvmcTxContext {
  return {
    txGasPrice: BigInt(ctx.txGasPrice.toString()),
    txOrigin: addressToBI(ctx.txOrigin),
    blockCoinbase: addressToBI(ctx.blockCoinbase),
    blockNumber: BigInt(ctx.blockNumber.toString()),
    blockTimestamp: BigInt(ctx.blockTimestamp.toString()),
    blockGasLimit: BigInt(ctx.blockGasLimit.toString()),
    blockDifficulty: BigInt(ctx.blockDifficulty.toString()),
    chainId: BigInt(ctx.chainId),
    blockBaseFee: BigInt(0)
  };
}

export function toEvmcMessage(msg: EVMCMessage): EvmcMessage {
  return {
    gas: bnToBI(msg.gas),
    flags: msg.isStatic ? evmc_flags.EVMC_STATIC : evmc_flags.EVMC_NO_FLAG,
    depth: msg.depth,
    sender: addressToBI(msg.sender),
    destination: addressToBI(msg.destination!),
    inputData: msg.inputData,
    value: bnToBI(msg.value),
    kind: msg.kind
  };
}

export function toEVMCMessage(msg: EvmcMessage): EVMCMessage {
  return {
    gas: biToBN(msg.gas),
    isStatic: msg.flags === evmc_flags.EVMC_STATIC,
    depth: msg.depth,
    sender: biToAddress(msg.sender),
    destination: biToAddress(msg.destination),
    inputData: msg.inputData,
    value: biToBN(msg.value),
    kind: msg.kind
  };
}

export function toEvmcResult(result: EVMCResult): EvmcResult {
  return {
    gasLeft: result.gasLeft ? bnToBI(result.gasLeft) : BigInt(0),
    statusCode: result.statusCode,
    outputData: result.outputData ?? Buffer.alloc(0),
    createAddress: result.createAddress ? addressToBI(result.createAddress) : BigInt(0)
  };
}
