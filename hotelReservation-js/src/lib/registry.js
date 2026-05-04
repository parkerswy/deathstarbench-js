import os from 'node:os';

function toUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let total = 0;
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    total = (total << 8) + value;
  }

  return total >>> 0;
}

function parseCidr(cidr) {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number.parseInt(prefixText, 10);
  const ip = toUint32(address);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    network: ip & mask,
    mask
  };
}

function cidrContains(cidr, ip) {
  const parsed = parseCidr(cidr);
  const value = toUint32(ip);
  if (!parsed || value === null) {
    return false;
  }
  return (value & parsed.mask) === parsed.network;
}

export function getLocalIp(logger) {
  const candidates = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        candidates.push(entry.address);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error('registry: can not find local ip');
  }

  let selected = candidates[0];

  if (candidates.length > 1) {
    const grpcNetwork = process.env.DSB_GRPC_NETWORK;
    if (grpcNetwork) {
      if (!parseCidr(grpcNetwork)) {
        logger.error(
          {
            grpcNetwork
          },
          'Invalid network CIDR in DSB_GRPC_NETWORK'
        );
      } else {
        for (const candidate of candidates) {
          if (cidrContains(grpcNetwork, candidate)) {
            selected = candidate;
            logger.info({ ip: selected }, 'gRPC traffic routed to dedicated network');
            break;
          }
        }
      }
    }
  }

  return selected;
}

export class RegistryClient {
  constructor(address, logger) {
    this.address = address;
    this.logger = logger;
    this.baseUrl = `http://${address}`;
  }

  async fetchJson(pathname, options = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, options);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`consul request failed ${response.status}: ${body}`);
    }
    return response;
  }

  async register(name, id, ip, port) {
    const address = ip || getLocalIp(this.logger);
    const payload = {
      ID: id,
      Name: name,
      Port: port,
      Address: address
    };

    this.logger.info(
      {
        name,
        id,
        address,
        port
      },
      'Registering service in consul'
    );

    await this.fetchJson('/v1/agent/service/register', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  }

  async deregister(id) {
    await this.fetchJson(`/v1/agent/service/deregister/${encodeURIComponent(id)}`, {
      method: 'PUT'
    });
  }

  async listServices(name) {
    const response = await this.fetchJson(
      `/v1/catalog/service/${encodeURIComponent(name)}`
    );
    return response.json();
  }
}
