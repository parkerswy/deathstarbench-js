'use strict';

const { handlerError, unauthorizedError } = require('../lib/errors');
const {
  hashPassword,
  key,
  randomString,
  signLoginToken,
  text,
  toBigInt,
  toLong,
  toWire,
  wireCreator
} = require('./common');

class UserHandler {
  constructor({ cache, collection, generator, secret, socialGraph, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.generator = generator;
    this.secret = secret;
    this.socialGraph = socialGraph;
    this.tracer = tracer;
  }

  async register(reqId, firstName, lastName, username, password, userId, carrier, spanName) {
    return this.tracer.withSpan(spanName, carrier, async (nextCarrier) => {
      if (await this.collection.findOne({ username })) {
        throw handlerError(`User ${username} already existed`);
      }

      const salt = randomString(32);
      const normalizedUserId = toBigInt(userId);
      await this.collection.insertOne({
        user_id: toLong(normalizedUserId),
        first_name: firstName,
        last_name: lastName,
        username,
        salt,
        password: hashPassword(password, salt)
      });

      await this.socialGraph.call('InsertUser', reqId, toWire(normalizedUserId), nextCarrier);
    });
  }

  RegisterUser(reqId, firstName, lastName, username, password, carrier) {
    return this.register(
      reqId,
      firstName,
      lastName,
      username,
      password,
      this.generator.next(),
      carrier,
      'RegisterUser'
    );
  }

  RegisterUserWithId(reqId, firstName, lastName, username, password, userId, carrier) {
    return this.register(
      reqId,
      firstName,
      lastName,
      username,
      password,
      userId,
      carrier,
      'RegisterUserWithId'
    );
  }

  ComposeCreatorWithUserId(reqId, userId, username, carrier) {
    return this.tracer.withSpan('ComposeCreatorWithUserId', carrier, async () =>
      wireCreator({ user_id: userId, username }));
  }

  ComposeCreatorWithUsername(reqId, username, carrier) {
    return this.tracer.withSpan('ComposeCreatorWithUsername', carrier, async () =>
      wireCreator({ user_id: await this.getUserId(username), username }));
  }

  async readLogin(username) {
    const cached = await this.cache.get(`${username}:login`);
    if (cached) {
      const parsed = JSON.parse(text(cached));
      return {
        user_id: BigInt(parsed.user_id),
        password: parsed.password,
        salt: parsed.salt
      };
    }

    const doc = await this.collection.findOne({ username });
    if (!doc) {
      throw unauthorizedError(`User: ${username} is not registered`);
    }
    if (!doc.password || !doc.salt || doc.user_id === undefined) {
      throw handlerError(`user: ${username} entry is NOT complete`);
    }

    const login = {
      user_id: toBigInt(doc.user_id),
      password: doc.password,
      salt: doc.salt
    };
    await this.cache.set(`${username}:login`, JSON.stringify({
      user_id: key(login.user_id),
      password: login.password,
      salt: login.salt
    }));
    return login;
  }

  Login(reqId, username, password, carrier) {
    return this.tracer.withSpan('Login', carrier, async () => {
      const login = await this.readLogin(username);
      if (hashPassword(password, login.salt) !== login.password) {
        throw unauthorizedError('Incorrect username or password');
      }
      return signLoginToken({
        secret: this.secret,
        userId: login.user_id,
        username
      });
    });
  }

  async getUserId(username) {
    const cached = await this.cache.get(`${username}:user_id`);
    if (cached) {
      return BigInt(text(cached));
    }

    const doc = await this.collection.findOne({ username });
    if (!doc) {
      throw handlerError(`User: ${username} is not registered`);
    }
    if (doc.user_id === undefined) {
      throw handlerError(`user_id attribute of user: ${username} was not found in the User object`);
    }

    const userId = toBigInt(doc.user_id);
    await this.cache.set(`${username}:user_id`, key(userId));
    return userId;
  }

  GetUserId(reqId, username, carrier) {
    return this.tracer.withSpan('GetUserId', carrier, () =>
      this.getUserId(username).then((userId) => toWire(userId)));
  }
}

module.exports = { UserHandler };
