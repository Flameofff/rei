import { Protocol } from './protocol';

const handlers: {
  name: string;
  code: number;
  response?: number;
  encode: (data: any) => any;
  decode: (data: any) => any;
}[] = [
  {
    name: 'Hellow',
    code: 0,
    encode: () => '',
    decode: () => ''
  }
];

export class ETHProtocol extends Protocol {
  private findHandler(key: string | number) {
    const handler = handlers.find((value) => (typeof key === 'string' ? value.name === key : value.code === key));
    if (!handler) {
      throw new Error(`Unkonw handler: ${key}`);
    }
    return handler;
  }

  get name() {
    return 'gxc2-ethwire';
  }

  get protocolString(): string {
    return `/${this.name}/1`;
  }

  encode(key: string | number, data: any): any {
    return this.findHandler(key).encode(data);
  }

  decode(key: string | number, data: any): any {
    return this.findHandler(key).decode(data);
  }

  encodeStatus(data: any): any {
    return this.findHandler(0).encode(data);
  }

  decodeStatus(data: any): any {
    return this.findHandler(0).decode(data);
  }
}