import fs from 'node:fs';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';

const certDir = path.resolve(process.cwd(), 'x509');

function readFile(name) {
  return fs.readFileSync(path.join(certDir, name));
}

function parseTlsMode() {
  const raw = process.env.TLS;
  if (raw === undefined || raw === '') {
    return { enabled: false, warning: null };
  }
  if (/^(0|false)$/i.test(raw)) {
    return { enabled: false, warning: null };
  }
  if (/^(1|true)$/i.test(raw)) {
    return { enabled: true, warning: null };
  }
  return {
    enabled: true,
    warning: `Unsupported TLS mode "${raw}". Falling back to default TLS settings.`
  };
}

const tlsMode = parseTlsMode();

export function isTlsEnabled() {
  return tlsMode.enabled;
}

export function getTlsWarning() {
  return tlsMode.warning;
}

export function getGrpcClientCredentials() {
  if (!tlsMode.enabled) {
    return grpc.credentials.createInsecure();
  }
  return grpc.credentials.createSsl(readFile('ca_cert.pem'));
}

export function getGrpcServerCredentials() {
  if (!tlsMode.enabled) {
    return grpc.ServerCredentials.createInsecure();
  }

  return grpc.ServerCredentials.createSsl(
    null,
    [
      {
        private_key: readFile('server_key.pem'),
        cert_chain: readFile('server_cert.pem')
      }
    ],
    false
  );
}

export function getHttpsOptions() {
  if (!tlsMode.enabled) {
    return null;
  }

  return {
    key: readFile('server_key.pem'),
    cert: readFile('server_cert.pem'),
    ca: readFile('ca_cert.pem')
  };
}
