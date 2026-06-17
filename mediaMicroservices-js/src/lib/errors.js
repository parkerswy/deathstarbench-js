'use strict';

const Types = require('../../gen-nodejs/media_service_types');

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

module.exports = { cacheError, dbError, handlerError, redisError, serviceError };

