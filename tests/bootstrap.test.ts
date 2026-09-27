import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BootstrapValidationError, loadBootstrapFiles } from '../packages/platform/src/index.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mongodb-bootstrap-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('MongoDB bootstrap file loading', () => {
  it('loads both service-owned bootstrap specifications', async () => {
    const orders = await loadBootstrapFiles(resolve('services/order-service/bootstrap'));
    const notifications = await loadBootstrapFiles(
      resolve('services/notification-service/bootstrap'),
    );

    expect(orders.map((file) => file.filename)).toEqual([
      '001_collections.json',
      '002_outbox_claims.json',
    ]);
    expect(orders[0]?.specification.collections.map((collection) => collection.name)).toEqual([
      'orders',
    ]);
    expect(
      notifications[0]?.specification.collections.map((collection) => collection.name),
    ).toEqual(['processed_events', 'notifications']);
  });

  it('rejects invalid bootstrap filenames', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(join(directory, 'collections.json'), '{"version":1,"collections":[]}');

    await expect(loadBootstrapFiles(directory)).rejects.toBeInstanceOf(BootstrapValidationError);
  });

  it('rejects a version that does not match its filename', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, '001_collections.json'),
      JSON.stringify({
        version: 2,
        collections: [{ name: 'orders', indexes: [] }],
      }),
    );

    await expect(loadBootstrapFiles(directory)).rejects.toThrow(
      'Bootstrap version does not match filename',
    );
  });

  it('rejects duplicate numeric versions', async () => {
    const directory = await createTemporaryDirectory();
    const specification = JSON.stringify({
      version: 1,
      collections: [{ name: 'orders', indexes: [] }],
    });
    await writeFile(join(directory, '001_collections.json'), specification);
    await writeFile(join(directory, '001_more_collections.json'), specification);

    await expect(loadBootstrapFiles(directory)).rejects.toThrow('Duplicate bootstrap version');
  });
});
