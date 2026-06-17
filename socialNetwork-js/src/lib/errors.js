'use strict';

const Types = require('../../gen-nodejs/social_network_types');

function serviceError(code, message) {
  return new Types.ServiceException({
    errorCode: Types.ErrorCode[code],
    message
  });
}

function dbError(message) {
  return serviceError('SE_MONGODB_ERROR', message);
}

function cacheError(message) {
  return serviceError('SE_MEMCACHED_ERROR', message);
}

function redisError(message) {
  return serviceError('SE_REDIS_ERROR', message);
}

function handlerError(message) {
  return serviceError('SE_THRIFT_HANDLER_ERROR', message);
}

function thriftError(message) {
  return serviceError('SE_THRIFT_CONN_ERROR', message);
}

function unauthorizedError(message) {
  return serviceError('SE_UNAUTHORIZED', message);
}

module.exports = {
  cacheError,
  dbError,
  handlerError,
  redisError,
  serviceError,
  thriftError,
  unauthorizedError
};
