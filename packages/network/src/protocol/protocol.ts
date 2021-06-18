import type { Peer, MsgContext } from '../peer';

export type Handler = {
  name: string;
  code: number;
  response?: number;
  encode: (info: MsgContext, data: any) => any;
  decode: (info: MsgContext, data: any) => any;
  process?: (info: MsgContext, data: any) => Promise<[string, any]> | [string, any] | void;
};

export abstract class Protocol {
  protected _status: any;

  get status() {
    return this._status;
  }

  get name(): string {
    throw new Error('Unimplemented');
  }

  get protocolString(): string {
    throw new Error('Unimplemented');
  }

  findHandler(key: string | number): Handler {
    throw new Error('Unimplemented');
  }

  handle(data: Buffer): { code: number; handler: Handler; payload: any } {
    throw new Error('Unimplemented');
  }

  async handshake(peer: Peer, localStatus: any): Promise<boolean> {
    const remoteStatus = await this._handshake(peer, localStatus);
    return this.isValidRemoteStatus(remoteStatus, localStatus);
  }

  protected _handshake(peer: Peer, data: any) {
    return this._status
      ? Promise.resolve(this._status)
      : new Promise<any>((resolve, reject) => {
          let timeout: any = setTimeout(() => {
            timeout = null;
            reject(new Error(`Protocol ${this.name} handshake timeout`));
          }, 8000);
          peer.once(`status:${this.name}`, (message) => {
            if (timeout) {
              clearTimeout(timeout);
              resolve((this._status = message));
            }
          });
          peer.send(this.name, 'Status', data);
        });
  }

  protected isValidRemoteStatus(remoteStatus: any, localStatus: any): boolean {
    throw new Error('Unimplemented');
  }
}