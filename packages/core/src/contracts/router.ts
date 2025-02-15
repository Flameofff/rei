import EVM from '@gxchain2-ethereumjs/vm/dist/evm/evm';
import { Address, BN, toBuffer } from 'ethereumjs-util';
import { Common } from '@rei-network/common';
import { Contract } from './contract';

// function selector of router
const methods = {
  estimateTotalFee: toBuffer('0xab124206'),
  assignTransactionReward: toBuffer('0xcec7a83e'),
  assignBlockReward: toBuffer('0x0cccae70'),
  slash: toBuffer('0x30b409a4'),
  onAfterBlock: toBuffer('0x9313f105')
};

export enum SlashReason {
  DuplicateVote = 0
}

export class Router extends Contract {
  constructor(evm: EVM, common: Common) {
    super(evm, common, methods, Address.fromString(common.param('vm', 'raddr')));
  }

  estimateTotalFee(sender: Address, to: Address, timestamp: number) {
    return this.runWithLogger(async () => {
      const { returnValue } = await this.executeMessage(this.makeCallMessage('estimateTotalFee', ['address', 'address', 'uint256'], [sender.toString(), to.toString(), timestamp]));
      let i = 0;
      return {
        fee: new BN(returnValue.slice(i++ * 32, i * 32)),
        freeFee: new BN(returnValue.slice(i++ * 32, i * 32)),
        contractFee: new BN(returnValue.slice(i++ * 32, i * 32))
      };
    });
  }

  assignTransactionReward(validator: Address, sender: Address, to: Address, feeUsage: BN, freeFeeUsage: BN, amount: BN, contractFee: BN) {
    return this.runWithLogger(async () => {
      const { logs } = await this.executeMessage(this.makeSystemCallerMessage('assignTransactionReward', ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'], [validator.toString(), sender.toString(), to.toString(), feeUsage.toString(), freeFeeUsage.toString(), contractFee.toString()], amount));
      return logs!;
    });
  }

  assignBlockReward(validator: Address, amount: BN) {
    return this.runWithLogger(async () => {
      const { logs } = await this.executeMessage(this.makeSystemCallerMessage('assignBlockReward', ['address'], [validator.toString()], amount));
      return logs;
    });
  }

  slash(validator: Address, reason: SlashReason) {
    return this.runWithLogger(async () => {
      const { logs } = await this.executeMessage(this.makeSystemCallerMessage('slash', ['address', 'uint8'], [validator.toString(), reason]));
      return logs;
    });
  }

  onAfterBlock(proposer: Address, activeValidators: Address[], priorities: BN[]) {
    return this.runWithLogger(async () => {
      await this.executeMessage(this.makeSystemCallerMessage('onAfterBlock', ['address', 'address[]', 'int256[]'], [proposer.toString(), activeValidators.map((addr) => addr.toString()), priorities.map((p) => p.toString())]));
    });
  }
}
