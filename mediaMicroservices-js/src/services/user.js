'use strict';

const jwt = require('jsonwebtoken');

const { handlerError, serviceError } = require('../lib/errors');
const { key, hashPassword, randomSalt, toBigInt, toLong, toWire, text } = require('./common');

class UserHandler {
  constructor({ cache, collection, compose, generator, secret, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.compose = compose;
    this.generator = generator;
    this.secret = secret;
    this.tracer = tracer;
  }

  async insertUser(userId, firstName, lastName, username, password) {
    if (await this.collection.findOne({ username })) {
      throw handlerError(`User ${username} already existed`);
    }
    const salt = randomSalt();
    await this.collection.insertOne({
      user_id: toLong(userId),
      first_name: firstName,
      last_name: lastName,
      username,
      salt,
      password: hashPassword(password, salt)
    });
  }

  RegisterUser(reqId, firstName, lastName, username, password, carrier) {
    return this.tracer.withSpan('RegisterUser', carrier, () =>
      this.insertUser(this.generator.next(), firstName, lastName, username, password));
  }

  RegisterUserWithId(reqId, firstName, lastName, username, password, userId, carrier) {
    return this.tracer.withSpan('RegisterUserWithId', carrier, () =>
      this.insertUser(toBigInt(userId), firstName, lastName, username, password));
  }

  UploadUserWithUserId(reqId, userId, carrier) {
    return this.tracer.withSpan('UploadUserWithUserId', carrier, (nextCarrier) =>
      this.compose.call('UploadUserId', reqId, userId, nextCarrier));
  }

  async UploadUserWithUsername(reqId, username, carrier) {
    return this.tracer.withSpan('UploadUserWithUsername', carrier, async (nextCarrier) => {
      const cacheKey = `${username}:user_id`;
      const cached = await this.cache.get(cacheKey);
      let userId;
      if (cached) {
        userId = BigInt(text(cached));
      } else {
        const user = await this.collection.findOne({ username });
        if (!user) {
          throw handlerError(`User: ${username} is not registered`);
        }
        userId = toBigInt(user.user_id);
      }
      await this.compose.call('UploadUserId', reqId, toWire(userId), nextCarrier);
      if (!cached) {
        await this.cache.set(cacheKey, key(userId));
      }
    });
  }

  async Login(reqId, username, password, carrier) {
    return this.tracer.withSpan('Login', carrier, async () => {
      const passwordKey = `${username}:password`;
      const saltKey = `${username}:salt`;
      const userIdKey = `${username}:user_id`;
      const cached = await this.cache.getMulti([passwordKey, saltKey, userIdKey]);
      let passwordHash = cached.get(passwordKey) && text(cached.get(passwordKey));
      let salt = cached.get(saltKey) && text(cached.get(saltKey));
      let userId = cached.get(userIdKey) && BigInt(text(cached.get(userIdKey)));
      if (!passwordHash || !salt || !userId) {
        const user = await this.collection.findOne({ username });
        if (!user) {
          throw serviceError('SE_UNAUTHORIZED', `User: ${username} is not registered`);
        }
        passwordHash ||= user.password;
        salt ||= user.salt;
        userId ||= toBigInt(user.user_id);
      }
      if (hashPassword(password, salt) !== passwordHash) {
        throw serviceError('SE_UNAUTHORIZED', 'Incorrect username or password');
      }
      await Promise.all([
        cached.has(passwordKey) ? null : this.cache.set(passwordKey, passwordHash),
        cached.has(saltKey) ? null : this.cache.set(saltKey, salt),
        cached.has(userIdKey) ? null : this.cache.set(userIdKey, key(userId))
      ]);
      return jwt.sign({
        user_id: key(userId),
        timestamp: `${Date.now()}`,
        TTL: '60000'
      }, this.secret, { algorithm: 'HS256' });
    });
  }
}

module.exports = { UserHandler };
