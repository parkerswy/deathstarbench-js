'use strict';

const crypto = require('node:crypto');

const CUSTOM_EPOCH = 1514764800000n;
const MAX_SIGNED_I64 = 0x7fffffffffffffffn;

class IdGenerator {
  constructor(machineId) {
    this.machineId = BigInt(`0x${machineId}`);
    this.lastTimestamp = -1n;
    this.counter = 0n;
  }

  next(now = BigInt(Date.now())) {
    const elapsed = now - CUSTOM_EPOCH;
    if (elapsed < this.lastTimestamp) {
      throw new Error('Timestamps are not incremental');
    }
    if (elapsed === this.lastTimestamp) {
      this.counter += 1n;
    } else {
      this.lastTimestamp = elapsed;
      this.counter = 0n;
    }
    return (((this.machineId & 0xfffn) << 52n) |
      ((elapsed & 0xffffffffffn) << 12n) |
      (this.counter & 0xfffn)) & MAX_SIGNED_I64;
  }
}

function machineId() {
  return crypto.randomBytes(2).readUInt16BE(0).toString(16).slice(-3).padStart(3, '0');
}

module.exports = { CUSTOM_EPOCH, IdGenerator, MAX_SIGNED_I64, machineId };
