import Message from '@gxchain2-ethereumjs/vm/dist/evm/message';
import { Address, MAX_INTEGER } from 'ethereumjs-util';
import { hexStringToBuffer } from '@gxchain2/utils';
import { Contract } from './contract';

// TODO: add methods
const methods = {};

// a class used to interact with the config contract
export class Config extends Contract {
  /**
   * Deploy config contract to `common.param('vm', 'cfgaddr')`
   */
  async deploy() {
    const cfgaddr = Address.fromString(this.common.param('vm', 'cfgaddr'));
    const result = await this.evm.executeMessage(
      new Message({
        contractAddress: cfgaddr,
        to: cfgaddr,
        gasLimit: MAX_INTEGER,
        // config code
        data: hexStringToBuffer(this.common.param('vm', 'cfgcode'))
      })
    );
    if (result.execResult.exceptionError) {
      throw result.execResult.exceptionError;
    }
  }
}
