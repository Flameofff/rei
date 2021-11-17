import { rlp, intToBuffer, bufferToInt } from 'ethereumjs-util';
import { ContructorWithCode, Registry } from '../../consensus/reimint';
import * as wireMessage from './wireMessage';
import { WireMessage } from './wireMessage';

export interface WireMessageConstructor extends ContructorWithCode<WireMessage> {
  fromValuesArray(values: any[]): WireMessage;
}

export class WireMessageFactory {
  private constructor() {}

  static registry = new Registry<WireMessage, WireMessageConstructor>();

  /**
   * Create a WireMessage instance from a serialized buffer
   * @param serialized - Serialized buffer
   * @returns WireMessage instance
   */
  static fromSerializedWireMessage(serialized: Buffer) {
    const values = rlp.decode(serialized);
    if (!Array.isArray(values)) {
      throw new Error('invalid serialized');
    }
    return WireMessageFactory.fromValuesArray(values);
  }

  /**
   * Create a WireMessage instance from raw value
   * @param values - Raw value
   * @returns WireMessage instance
   */
  static fromValuesArray(values: Buffer[]) {
    if (values.length !== 2) {
      throw new Error('invalid serialized');
    }

    const [codeBuffer, valuesArray] = values;
    if (!(codeBuffer instanceof Buffer) || !Array.isArray(valuesArray) || valuesArray.length === 0) {
      throw new Error('invalid serialized');
    }

    return WireMessageFactory.registry.getCtorByCode(bufferToInt(codeBuffer)).fromValuesArray(valuesArray);
  }

  /**
   * Convert a WireMessage instance to raw value
   * @param _message - WireMessage instance
   * @returns Raw value
   */
  static rawMessage<T extends WireMessage>(_message: T) {
    const code = WireMessageFactory.registry.getCodeByInstance(_message);
    return [intToBuffer(code), _message.raw()];
  }

  /**
   * Serialize a WireMessage instance to a buffer
   * @param _message - WireMessage instance
   * @returns Serialized buffer
   */
  static serializeMessage<T extends WireMessage>(_message: T) {
    return rlp.encode(WireMessageFactory.rawMessage(_message));
  }
}

WireMessageFactory.registry.register(wireMessage.StatusMessage);
WireMessageFactory.registry.register(wireMessage.GetBlockHeadersMessage);
WireMessageFactory.registry.register(wireMessage.BlockHeadersMessage);
WireMessageFactory.registry.register(wireMessage.GetBlockBodiesMessage);
WireMessageFactory.registry.register(wireMessage.BlockBodiesMessage);
WireMessageFactory.registry.register(wireMessage.NewBlockMessage);
WireMessageFactory.registry.register(wireMessage.NewPooledTransactionHashesMessage);
WireMessageFactory.registry.register(wireMessage.GetPooledTransactionsMessage);
WireMessageFactory.registry.register(wireMessage.PooledTransactionsMessage);
