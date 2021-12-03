import { Address, BN, generateAddress } from 'ethereumjs-util';
import { DefaultStateManager as StateManager } from '@gxchain2-ethereumjs/vm/dist/state';
import { EIP2929StateManager } from '@gxchain2-ethereumjs/vm/dist/state/interface';
import { Log } from '@gxchain2-ethereumjs/vm/dist/evm/types';
import { setLengthLeftStorage } from '@gxchain2-ethereumjs/vm/dist/evm/opcodes/util';
import { Database } from '@gxchain2/database';
import { Evmc, EvmcStorageStatus, EvmcMessage, EvmcTxContext, EvmcAccessStatus, EvmcRevision } from '@gxchain2/evmc';
import { biToAddress, biToBN, biToBuffer, bnToBI, bufferToBI, EVMCMessage, EVMCTxContext, toEVMCMessage, toEvmcMessage, toEvmcTxContext } from './utils';
import { getPrecompile } from './precompiles';

export class EVMC extends Evmc {
  ctx!: EvmcTxContext;
  readonly db: Database;
  readonly stateManager: StateManager;
  readonly logs: Log[] = [];

  constructor(db: Database, stateManager: StateManager) {
    super();
    this.db = db;
    this.stateManager = stateManager;
  }

  getAccountExists(address: bigint) {
    return this.stateManager.accountExists(biToAddress(address));
  }

  async getStorage(account: bigint, key: bigint) {
    return bufferToBI(await this.stateManager.getContractStorage(biToAddress(account), biToBuffer(key)));
  }

  async setStorage(account: bigint, key: bigint, value: bigint) {
    const _account = biToAddress(account);
    const _key = biToBuffer(key);
    const _value = setLengthLeftStorage(biToBuffer(value));

    const currentStorage = setLengthLeftStorage(await this.stateManager.getContractStorage(_account, _key));
    const originalStorage = setLengthLeftStorage(await this.stateManager.getOriginalContractStorage(_account, _key));

    await this.stateManager.putContractStorage(_account, _key, _value);

    if (currentStorage.equals(_value)) {
      return EvmcStorageStatus.EVMC_STORAGE_UNCHANGED;
    }

    if (originalStorage.equals(currentStorage)) {
      if (originalStorage.length === 0) {
        return EvmcStorageStatus.EVMC_STORAGE_ADDED;
      }

      if (_value.length === 0) {
        return EvmcStorageStatus.EVMC_STORAGE_DELETED;
      }

      return EvmcStorageStatus.EVMC_STORAGE_MODIFIED;
    }

    if (originalStorage.length > 0) {
      if (currentStorage.length === 0) {
        return EvmcStorageStatus.EVMC_STORAGE_MODIFIED_AGAIN;
      } else if (_value.length === 0) {
        return EvmcStorageStatus.EVMC_STORAGE_DELETED;
      }
    }

    if (originalStorage.equals(_value)) {
      if (originalStorage.length === 0) {
        return EvmcStorageStatus.EVMC_STORAGE_DELETED;
      } else {
        return EvmcStorageStatus.EVMC_STORAGE_MODIFIED_AGAIN;
      }
    }

    return EvmcStorageStatus.EVMC_STORAGE_MODIFIED_AGAIN;
  }

  async getBalance(account: bigint) {
    return bnToBI((await this.stateManager.getAccount(biToAddress(account))).balance);
  }

  async getCodeSize(address: bigint) {
    return BigInt((await this.stateManager.getContractCode(biToAddress(address))).length);
  }

  async getCodeHash(address: bigint) {
    const account = await this.stateManager.getAccount(biToAddress(address));
    return bufferToBI(account.codeHash);
  }

  async copyCode(account: bigint, offset: number, length: number) {
    const code = await this.stateManager.getContractCode(biToAddress(account));
    return code.slice(offset, offset + length);
  }

  async selfDestruct(address: bigint, beneficiary: bigint) {
    const _address = biToAddress(address);
    const _beneficiary = biToAddress(beneficiary);

    const account = await this.stateManager.getAccount(_address);

    // Add to beneficiary balance
    const toAccount = await this.stateManager.getAccount(_beneficiary);
    toAccount.balance.iadd(account.balance);
    await this.stateManager.putAccount(_beneficiary, toAccount);

    // Subtract from contract balance
    account.balance = new BN(0);
    await this.stateManager.putAccount(_address, account);
  }

  async call(message: EvmcMessage) {
    const common = this.stateManager._common;
    const _message = toEVMCMessage(message);
    const fn = getPrecompile(_message.destination!, common);
    if (fn) {
      return fn(_message, common);
    } else {
      const code = await this.stateManager.getContractCode(_message.destination!);
      return this.execute(message, code, EvmcRevision.EVMC_BERLIN);
    }
  }

  getTxContext() {
    return this.ctx;
  }

  async getBlockHash(num: bigint) {
    try {
      const hash = await this.db.numberToHash(biToBN(num));
      return bufferToBI(hash);
    } catch (err) {
      return BigInt(0);
    }
  }

  emitLog(address: bigint, data: Buffer, topics: Array<bigint>) {
    const log: Log = [biToBuffer(address, 20), topics.map(biToBuffer), data];
    this.logs.push(log);
  }

  async accessAccount(account: bigint) {
    const address = biToBuffer(account, 20);
    const warmed = await (this.stateManager as EIP2929StateManager).isWarmedAddress(address);
    if (!warmed) {
      await (this.stateManager as EIP2929StateManager).addWarmedAddress(address);
    }
    return warmed ? EvmcAccessStatus.EVMC_ACCESS_WARM : EvmcAccessStatus.EVMC_ACCESS_COLD;
  }

  async accessStorage(address: bigint, key: bigint) {
    const _address = biToBuffer(address, 20);
    const _key = biToBuffer(key);
    const warmed = await (this.stateManager as EIP2929StateManager).isWarmedStorage(_address, _key);
    if (!warmed) {
      await (this.stateManager as EIP2929StateManager).addWarmedStorage(_address, _key);
    }
    return warmed ? EvmcAccessStatus.EVMC_ACCESS_WARM : EvmcAccessStatus.EVMC_ACCESS_COLD;
  }

  async executeMessage(message: EVMCMessage, ctx: EVMCTxContext, nonce: BN) {
    this.ctx = toEvmcTxContext(ctx);

    let code: Buffer;
    if (message.destination) {
      const common = this.stateManager._common;
      const fn = getPrecompile(message.destination, common);
      if (fn) {
        return fn(message, common);
      } else {
        code = await this.stateManager.getContractCode(message.destination);
      }
    } else {
      code = message.inputData;
      message.inputData = Buffer.from([]);
      message.destination = new Address(generateAddress(message.sender.buf, nonce.toArrayLike(Buffer)));
    }

    return this.execute(toEvmcMessage(message), code, EvmcRevision.EVMC_BERLIN);
  }
}
