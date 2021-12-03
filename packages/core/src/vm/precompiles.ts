import { setLengthRight, setLengthLeft, publicToAddress, BN, ecrecover, sha256, ripemd160, Address } from 'ethereumjs-util';
import { Common } from '@gxchain2/common';
import { EvmcResult, EvmcStatusCode } from '@gxchain2/evmc';
const bn128 = require('rustbn.js');
import { toEvmcResult, EVMCMessage } from './utils';

function _ecrecover(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'ecRecover'));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  const data = setLengthRight(message.inputData, 128);

  const msgHash = data.slice(0, 32);
  const v = data.slice(32, 64);
  const r = data.slice(64, 96);
  const s = data.slice(96, 128);

  let publicKey;
  try {
    publicKey = ecrecover(msgHash, new BN(v), r, s);
  } catch (e) {
    return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS });
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: setLengthLeft(publicToAddress(publicKey), 32) });
}

function _sha256(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'sha256'));
  gasUsed.iadd(new BN(common.param('gasPrices', 'sha256Word')).imuln(Math.ceil(message.inputData.length / 32)));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: sha256(message.inputData) });
}

function _ripemd160(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'ripemd160'));
  gasUsed.iadd(new BN(common.param('gasPrices', 'ripemd160Word')).imuln(Math.ceil(message.inputData.length / 32)));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: ripemd160(message.inputData, true) });
}

function _identity(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'identity'));
  gasUsed.iadd(new BN(common.param('gasPrices', 'identityWord')).imuln(Math.ceil(message.inputData.length / 32)));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: message.inputData });
}

function multComplexity(x: BN): BN {
  let fac1;
  let fac2;
  if (x.lten(64)) {
    return x.sqr();
  } else if (x.lten(1024)) {
    // return Math.floor(Math.pow(x, 2) / 4) + 96 * x - 3072
    fac1 = x.sqr().divn(4);
    fac2 = x.muln(96);
    return fac1.add(fac2).subn(3072);
  } else {
    // return Math.floor(Math.pow(x, 2) / 16) + 480 * x - 199680
    fac1 = x.sqr().divn(16);
    fac2 = x.muln(480);
    return fac1.add(fac2).subn(199680);
  }
}

function multComplexityEIP2565(x: BN): BN {
  const words = x.addn(7).divn(8);
  return words.mul(words);
}

function getAdjustedExponentLength(data: Buffer): BN {
  let expBytesStart;
  try {
    const baseLen = new BN(data.slice(0, 32)).toNumber();
    expBytesStart = 96 + baseLen; // 96 for base length, then exponent length, and modulus length, then baseLen for the base data, then exponent bytes start
  } catch (e) {
    expBytesStart = Number.MAX_SAFE_INTEGER - 32;
  }
  const expLen = new BN(data.slice(32, 64));
  let firstExpBytes = Buffer.from(data.slice(expBytesStart, expBytesStart + 32)); // first word of the exponent data
  firstExpBytes = setLengthRight(firstExpBytes, 32); // reading past the data reads virtual zeros
  let firstExpBN = new BN(firstExpBytes);
  let max32expLen = 0;
  if (expLen.ltn(32)) {
    max32expLen = 32 - expLen.toNumber();
  }
  firstExpBN = firstExpBN.shrn(8 * Math.max(max32expLen, 0));

  let bitLen = -1;
  while (firstExpBN.gtn(0)) {
    bitLen = bitLen + 1;
    firstExpBN = firstExpBN.ushrn(1);
  }
  let expLenMinus32OrZero = expLen.subn(32);
  if (expLenMinus32OrZero.ltn(0)) {
    expLenMinus32OrZero = new BN(0);
  }
  const eightTimesExpLenMinus32OrZero = expLenMinus32OrZero.muln(8);
  const adjustedExpLen = eightTimesExpLenMinus32OrZero;
  if (bitLen > 0) {
    adjustedExpLen.iaddn(bitLen);
  }
  return adjustedExpLen;
}

function expmod(B: BN, E: BN, M: BN): BN {
  if (E.isZero()) return new BN(1).mod(M);
  // Red asserts M > 1
  if (M.lten(1)) return new BN(0);
  const red = BN.red(M);
  const redB = B.toRed(red);
  const res = redB.redPow(E);
  return res.fromRed();
}

function _modexp(message: EVMCMessage, common: Common): EvmcResult {
  const data = message.inputData;

  let adjustedELen = getAdjustedExponentLength(data);
  if (adjustedELen.ltn(1)) {
    adjustedELen = new BN(1);
  }

  const bLen = new BN(data.slice(0, 32));
  const eLen = new BN(data.slice(32, 64));
  const mLen = new BN(data.slice(64, 96));

  let maxLen = bLen;
  if (maxLen.lt(mLen)) {
    maxLen = mLen;
  }
  const Gquaddivisor = common.param('gasPrices', 'modexpGquaddivisor');
  let gasUsed;

  const bStart = new BN(96);
  const bEnd = bStart.add(bLen);
  const eStart = bEnd;
  const eEnd = eStart.add(eLen);
  const mStart = eEnd;
  const mEnd = mStart.add(mLen);

  if (!common.isActivatedEIP(2565)) {
    gasUsed = adjustedELen.mul(multComplexity(maxLen)).divn(Gquaddivisor);
  } else {
    gasUsed = adjustedELen.mul(multComplexityEIP2565(maxLen)).divn(Gquaddivisor);
    if (gasUsed.ltn(200)) {
      gasUsed = new BN(200);
    }
  }

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  if (bLen.isZero()) {
    return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: new BN(0).toArrayLike(Buffer, 'be', mLen.toNumber()) });
  }

  if (mLen.isZero()) {
    return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: Buffer.alloc(0) });
  }

  const maxInt = new BN(Number.MAX_SAFE_INTEGER);
  const maxSize = new BN(2147483647); // ethereumjs-util setLengthRight limitation

  if (bLen.gt(maxSize) || eLen.gt(maxSize) || mLen.gt(maxSize)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const B = new BN(setLengthRight(data.slice(bStart.toNumber(), bEnd.toNumber()), bLen.toNumber()));
  const E = new BN(setLengthRight(data.slice(eStart.toNumber(), eEnd.toNumber()), eLen.toNumber()));
  const M = new BN(setLengthRight(data.slice(mStart.toNumber(), mEnd.toNumber()), mLen.toNumber()));

  if (mEnd.gt(maxInt)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  let R;
  if (M.isZero()) {
    R = new BN(0);
  } else {
    R = expmod(B, E, M);
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: R.toArrayLike(Buffer, 'be', mLen.toNumber()) });
}

function _ecadd(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'ecAdd'));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  const returnData = bn128.add(message.inputData);

  // check ecadd success or failure by comparing the output length
  if (returnData.length !== 64) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: returnData });
}

function _ecmul(message: EVMCMessage, common: Common): EvmcResult {
  const gasUsed = new BN(common.param('gasPrices', 'ecMul'));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  const returnData = bn128.mul(message.inputData);

  // check ecadd success or failure by comparing the output length
  if (returnData.length !== 64) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: returnData });
}

function _ecpairing(message: EVMCMessage, common: Common): EvmcResult {
  // no need to care about non-divisible-by-192, because bn128.pairing will properly fail in that case
  const inputDataSize = Math.floor(message.inputData.length / 192);
  const gasUsed = new BN(<number>common.param('gasPrices', 'ecPairing') + inputDataSize * common.param('gasPrices', 'ecPairingWord'));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  const returnData = bn128.pairing(message.inputData);

  // check ecpairing success or failure by comparing the output length
  if (returnData.length !== 32) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: returnData });
}

// The following blake2 code has been taken from (license: Creative Commons CC0):
// https://github.com/dcposch/blakejs/blob/410c640d0f08d3b26904c6d1ab3d81df3619d282/blake2s.js
// The modifications include:
//  - Avoiding the use of context in F
//  - F accepts number of rounds as parameter
//  - Expect 2 64-byte t values, xor them both
//  - Take modulo 10 for indices of SIGMA
//  - Added type annotations
//  - Moved previously global `v` and `m` variables inside the F function

// 64-bit unsigned addition
// Sets v[a,a+1] += v[b,b+1]
// v should be a Uint32Array
function ADD64AA(v: Uint32Array, a: number, b: number) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) {
    o1++;
  }
  v[a] = o0;
  v[a + 1] = o1;
}

// 64-bit unsigned addition
// Sets v[a,a+1] += b
// b0 is the low 32 bits of b, b1 represents the high 32 bits
function ADD64AC(v: Uint32Array, a: number, b0: number, b1: number) {
  let o0 = v[a] + b0;
  if (b0 < 0) {
    o0 += 0x100000000;
  }
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) {
    o1++;
  }
  v[a] = o0;
  v[a + 1] = o1;
}

// Little-endian byte access
function B2B_GET32(arr: Uint32Array, i: number) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24);
}

// G Mixing function
// The ROTRs are inlined for speed
function B2B_G(v: Uint32Array, mw: Uint32Array, a: number, b: number, c: number, d: number, ix: number, iy: number) {
  const x0 = mw[ix];
  const x1 = mw[ix + 1];
  const y0 = mw[iy];
  const y1 = mw[iy + 1];

  ADD64AA(v, a, b); // v[a,a+1] += v[b,b+1] ... in JS we must store a uint64 as two uint32s
  ADD64AC(v, a, x0, x1); // v[a, a+1] += x ... x0 is the low 32 bits of x, x1 is the high 32 bits

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated to the right by 32 bits
  let xor0 = v[d] ^ v[a];
  let xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;

  ADD64AA(v, c, d);

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 24 bits
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);

  ADD64AA(v, a, b);
  ADD64AC(v, a, y0, y1);

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated right by 16 bits
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);

  ADD64AA(v, c, d);

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 63 bits
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

// Initialization Vector
// prettier-ignore
const BLAKE2B_IV32 = new Uint32Array([0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,]);

// prettier-ignore
const SIGMA8 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,];

// These are offsets into a uint64 buffer.
// Multiply them all by 2 to make them offsets into a uint32 buffer,
// because this is Javascript and we don't have uint64s
const SIGMA82 = new Uint8Array(
  SIGMA8.map(function (x) {
    return x * 2;
  })
);

function F(h: Uint32Array, m: Uint32Array, t: Uint32Array, f: boolean, rounds: number) {
  const v = new Uint32Array(32);
  let i = 0;

  // init work variables
  for (i = 0; i < 16; i++) {
    v[i] = h[i];
    v[i + 16] = BLAKE2B_IV32[i];
  }

  // 128 bits of offset
  v[24] = v[24] ^ t[0];
  v[25] = v[25] ^ t[1];
  v[26] = v[26] ^ t[2];
  v[27] = v[27] ^ t[3];

  // last block flag set ?
  if (f) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }

  // message words
  const mw = new Uint32Array(32);
  // get little-endian words
  for (i = 0; i < 32; i++) {
    mw[i] = B2B_GET32(m, 4 * i);
  }

  // twelve rounds of mixing
  // uncomment the DebugPrint calls to log the computation
  // and match the RFC sample documentation
  // util.debugPrint('          m[16]', m, 64)
  for (i = 0; i < rounds; i++) {
    // util.debugPrint('   (i=' + (i < 10 ? ' ' : '') + i + ') v[16]', v, 64)
    const ri = (i % 10) * 16;
    B2B_G(v, mw, 0, 8, 16, 24, SIGMA82[ri + 0], SIGMA82[ri + 1]);
    B2B_G(v, mw, 2, 10, 18, 26, SIGMA82[ri + 2], SIGMA82[ri + 3]);
    B2B_G(v, mw, 4, 12, 20, 28, SIGMA82[ri + 4], SIGMA82[ri + 5]);
    B2B_G(v, mw, 6, 14, 22, 30, SIGMA82[ri + 6], SIGMA82[ri + 7]);
    B2B_G(v, mw, 0, 10, 20, 30, SIGMA82[ri + 8], SIGMA82[ri + 9]);
    B2B_G(v, mw, 2, 12, 22, 24, SIGMA82[ri + 10], SIGMA82[ri + 11]);
    B2B_G(v, mw, 4, 14, 16, 26, SIGMA82[ri + 12], SIGMA82[ri + 13]);
    B2B_G(v, mw, 6, 8, 18, 28, SIGMA82[ri + 14], SIGMA82[ri + 15]);
  }

  for (i = 0; i < 16; i++) {
    h[i] = h[i] ^ v[i] ^ v[i + 16];
  }
}

function _blake2f(message: EVMCMessage, common: Common): EvmcResult {
  const data = message.inputData;
  if (data.length !== 213) {
    return toEvmcResult({
      gasLeft: new BN(0),
      outputData: Buffer.alloc(0),
      statusCode: EvmcStatusCode.EVMC_ARGUMENT_OUT_OF_RANGE
    });
  }
  const lastByte = data.slice(212, 213)[0];
  if (lastByte !== 1 && lastByte !== 0) {
    return toEvmcResult({
      gasLeft: new BN(0),
      outputData: Buffer.alloc(0),
      statusCode: EvmcStatusCode.EVMC_ARGUMENT_OUT_OF_RANGE
    });
  }

  const rounds = data.slice(0, 4).readUInt32BE(0);
  const hRaw = data.slice(4, 68);
  const mRaw = data.slice(68, 196);
  const tRaw = data.slice(196, 212);
  // final
  const f = lastByte === 1;

  const gasUsed = new BN(common.param('gasPrices', 'blake2Round'));
  gasUsed.imul(new BN(rounds));

  if (message.gas.lt(gasUsed)) {
    return toEvmcResult({ statusCode: EvmcStatusCode.EVMC_OUT_OF_GAS, gasLeft: new BN(0) });
  }

  const gasLeft = message.gas.sub(gasUsed);

  const h = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    h[i] = hRaw.readUInt32LE(i * 4);
  }

  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    m[i] = mRaw.readUInt32LE(i * 4);
  }

  const t = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    t[i] = tRaw.readUInt32LE(i * 4);
  }

  F(h, m, t, f, rounds);

  const output = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) {
    output.writeUInt32LE(h[i], i * 4);
  }

  return toEvmcResult({ gasLeft, statusCode: EvmcStatusCode.EVMC_SUCCESS, outputData: output });
}

export type PrecompileFunction = (message: EVMCMessage, common: Common) => EvmcResult;

export const ripemdPrecompileAddress = '0000000000000000000000000000000000000003';

export const precompiles: {
  [address: string]: {
    hardfork: string;
    fn: PrecompileFunction;
  };
} = {
  '0000000000000000000000000000000000000001': {
    hardfork: 'chainstart',
    fn: _ecrecover
  },
  '0000000000000000000000000000000000000002': {
    hardfork: 'chainstart',
    fn: _sha256
  },
  [ripemdPrecompileAddress]: {
    hardfork: 'chainstart',
    fn: _ripemd160
  },
  '0000000000000000000000000000000000000004': {
    hardfork: 'chainstart',
    fn: _identity
  },
  '0000000000000000000000000000000000000005': {
    hardfork: 'byzantium',
    fn: _modexp
  },
  '0000000000000000000000000000000000000006': {
    hardfork: 'byzantium',
    fn: _ecadd
  },
  '0000000000000000000000000000000000000007': {
    hardfork: 'byzantium',
    fn: _ecmul
  },
  '0000000000000000000000000000000000000008': {
    hardfork: 'byzantium',
    fn: _ecpairing
  },
  '0000000000000000000000000000000000000009': {
    hardfork: 'byzantium',
    fn: _blake2f
  }
};

export function getPrecompile(address: Address, common: Common) {
  const addr = address.buf.toString('hex');
  const info = precompiles[addr];
  if (info) {
    if (common.gteHardfork(info.hardfork)) {
      return info.fn;
    }
  }
}

export function getActivePrecompiles(common: Common): Address[] {
  const activePrecompiles: Address[] = [];
  for (const addressString in precompiles) {
    const address = new Address(Buffer.from(addressString, 'hex'));
    if (getPrecompile(address, common)) {
      activePrecompiles.push(address);
    }
  }
  return activePrecompiles;
}
