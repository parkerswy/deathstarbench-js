export async function resolveServiceAddress(registry, serviceName, knativeDns = '') {
  const resolvedName = knativeDns ? `${serviceName}.${knativeDns}` : serviceName;
  const entries = await registry.listServices(resolvedName);

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`No consul registration found for ${resolvedName}`);
  }

  const entry = entries[0];
  const host = entry.ServiceAddress || entry.Address;
  const port = entry.ServicePort;

  if (!host || !port) {
    throw new Error(`Invalid consul registration for ${resolvedName}`);
  }

  return `${host}:${port}`;
}
