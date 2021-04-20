import { Transaction } from '@ethereumjs/tx';
import { Address, bufferToHex, BN } from 'ethereumjs-util';

type URL = {
  Scheme: string;
  Path: string;
};

export type Accountinfo = {
  address: Address;
  url: URL;
};

function stringcompare(a: string, b: string) {
  if (a == b) {
    return 0;
  }
  if (a < b) {
    return -1;
  }
  return 1;
}

export function urlcompare(url1: URL, url2: URL): number {
  if (url1.Scheme == url2.Scheme) {
    return stringcompare(url1.Path, url2.Path);
  }
  return stringcompare(url1.Scheme, url2.Scheme);
}

export interface Wallet {
  url();

  status(): string;

  open(passphrase: string);

  close();

  accounts(): Accountinfo[];

  contain(account: Accountinfo): boolean;

  derive(path: Buffer, pin: boolean): Accountinfo | undefined;

  selfDerive(base: Buffer[]); //todo anther  parameter

  signData(account: Accountinfo, mimeType: string, data: Buffer);

  signDataWithPassphrase(account: Accountinfo, passphrase, mimeType: string, data: Buffer);

  signText(account: Accountinfo, text: Buffer);

  signTextWithPassphrase(account: Accountinfo, passphrase: string, text: Buffer);

  // signTx(account: Accountinfo, tx: Transaction, chainID: number): Transaction;

  // signTxWithPassphrase(account: Accountinfo, passphrase: string, tx: Transaction, chainID: number): Transaction;
}

export type Backend = {
  wallets(): Wallet[];
  subscribe();
};
