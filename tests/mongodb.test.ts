import { describe, expect, it } from 'vitest';

import {
  closeMongo,
  createMongoClient,
  createMongoDbInstrumentation,
  isMongoDuplicateKeyError,
} from '../packages/platform/src/index.js';

describe('MongoDB platform helpers', () => {
  it('applies explicit connection-pool overrides', async () => {
    const client = createMongoClient({
      uri: 'mongodb://127.0.0.1:27017',
      applicationName: 'configuration-test',
      maxPoolSize: 25,
      minPoolSize: 2,
      serverSelectionTimeoutMs: 12_345,
    });
    const options = client.options;

    expect(options).toMatchObject({
      appName: 'configuration-test',
      maxPoolSize: 25,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 12_345,
    });
    await closeMongo(client);
  });

  it('does not misclassify ordinary errors as duplicate-key failures', () => {
    expect(isMongoDuplicateKeyError(new Error('ordinary failure'))).toBe(false);
  });

  it('creates MongoDB tracing with enhanced database reporting disabled', () => {
    const instrumentation = createMongoDbInstrumentation();

    expect(instrumentation.getConfig()).toMatchObject({
      enhancedDatabaseReporting: false,
    });
  });
});
