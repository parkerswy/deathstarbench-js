'use strict';

const Int64 = require('node-int64');
const { Long } = require('mongodb');

function fromBuffer(buffer) {
  const bytes = Buffer.from(buffer);
  let unsigned = BigInt(`0x${bytes.toString('hex') || '0'}`);
  if ((bytes[0] & 0x80) !== 0) {
    unsigned -= 1n << BigInt(bytes.length * 8);
  }
  return unsigned;
}

function toBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (Long.isLong(value)) {
    return value.toBigInt();
  }
  if (value instanceof Int64) {
    return fromBuffer(value.buffer);
  }
  if (Buffer.isBuffer(value)) {
    return fromBuffer(value);
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Unsafe i64 number ${value}`);
    }
    return BigInt(value);
  }
  if (value && Buffer.isBuffer(value.buffer)) {
    return fromBuffer(value.buffer);
  }
  throw new TypeError(`Cannot convert ${typeof value} to i64`);
}

function toWire(value) {
  const bigint = toBigInt(value);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(bigint);
  return new Int64(buffer);
}

function toLong(value) {
  return Long.fromBigInt(toBigInt(value));
}

function key(value) {
  return toBigInt(value).toString(10);
}

function timestamp() {
  return BigInt(Date.now());
}

module.exports = { key, timestamp, toBigInt, toLong, toWire };

