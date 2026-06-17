'use strict';

const Types = require('../../gen-nodejs/social_network_types');
const { IdGenerator, machineId } = require('../lib/idGenerator');
const { nowMs, toBigInt, toWire, wirePost } = require('./common');

class UniqueIdHandler {
  constructor({ generator = new IdGenerator(machineId()), tracer }) {
    this.generator = generator;
    this.tracer = tracer;
  }

  ComposeUniqueId(reqId, postType, carrier) {
    return this.tracer.withSpan('ComposeUniqueId', carrier, async () =>
      toWire(this.generator.next()));
  }
}

class ComposePostHandler {
  constructor({
    homeTimeline,
    media,
    postStorage,
    text,
    uniqueId,
    user,
    userTimeline,
    tracer
  }) {
    this.homeTimeline = homeTimeline;
    this.media = media;
    this.postStorage = postStorage;
    this.text = text;
    this.uniqueId = uniqueId;
    this.user = user;
    this.userTimeline = userTimeline;
    this.tracer = tracer;
  }

  async ComposePost(reqId, username, userIdValue, postText, mediaIds, mediaTypes, postType, carrier) {
    return this.tracer.withSpan('ComposePost', carrier, async (nextCarrier) => {
      const timestamp = nowMs();
      const [textReturn, creator, media, postId] = await Promise.all([
        this.text.call('ComposeText', reqId, postText, nextCarrier),
        this.user.call('ComposeCreatorWithUserId', reqId, userIdValue, username, nextCarrier),
        this.media.call('ComposeMedia', reqId, mediaTypes || [], mediaIds || [], nextCarrier),
        this.uniqueId.call('ComposeUniqueId', reqId, postType, nextCarrier)
      ]);

      const post = {
        post_id: postId,
        creator,
        req_id: reqId,
        text: textReturn.text,
        user_mentions: textReturn.user_mentions || [],
        media: media || [],
        urls: textReturn.urls || [],
        timestamp,
        post_type: postType ?? Types.PostType.POST
      };

      const wireValue = wirePost(post);
      const mentionIds = post.user_mentions.map((mention) => mention.user_id);
      await this.postStorage.call('StorePost', reqId, wireValue, nextCarrier);
      await this.userTimeline.call('WriteUserTimeline', reqId, postId, userIdValue, toWire(timestamp), nextCarrier);
      await this.homeTimeline.call(
        'WriteHomeTimeline',
        reqId,
        postId,
        userIdValue,
        toWire(timestamp),
        mentionIds.map((mentionId) => toWire(toBigInt(mentionId))),
        nextCarrier
      );
    });
  }
}

module.exports = { ComposePostHandler, UniqueIdHandler };
