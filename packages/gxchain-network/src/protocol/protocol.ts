import type { Peer } from '../peer/peer';

export class Protocol {
  private _status: any;

  get status() {
    return this._status;
  }

  get name(): string {
    throw new Error('Unimplemented');
  }

  get protocolString(): string {
    throw new Error('Unimplemented');
  }

  encode(key: string | number, data: any): any {
    throw new Error('Unimplemented');
  }

  decode(key: string | number, data: any): any {
    throw new Error('Unimplemented');
  }

  encodeStatus(data: any): any {
    throw new Error('Unimplemented');
  }

  decodeStatus(data: any): any {
    throw new Error('Unimplemented');
  }

  handshake(peer: Peer, data: any) {
    return this._status
      ? Promise.resolve(this._status)
      : new Promise<any>((resolve, reject) => {
          let timeout: any = setTimeout(() => {
            timeout = null;
            reject(new Error(`Protocol ${this.name} handshake timeout`));
          }, 8000);
          peer.once(`status:${this.name}`, (peer, message) => {
            if (timeout) {
              clearTimeout(timeout);
              resolve((this._status = this.decodeStatus(message)));
            }
          });
          peer.send(this.encodeStatus(data));
        });
  }
}