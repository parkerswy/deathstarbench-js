export function setCors(reply) {
  reply.header('Access-Control-Allow-Origin', '*');
}

export function sendHttpError(reply, message, statusCode) {
  reply.code(statusCode);
  reply.type('text/plain; charset=utf-8');
  reply.send(`${message}\n`);
}

export function sendJson(reply, payload) {
  reply.type('application/json; charset=utf-8');
  reply.send(`${JSON.stringify(payload)}\n`);
}
