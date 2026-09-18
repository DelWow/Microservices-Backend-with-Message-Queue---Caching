import { resolve } from 'node:path';

import { applyBootstrap } from './bootstrap.js';
import { parseCommonEnvironment } from './environment.js';
import { createLogger } from './logger.js';
import { closeMongo, connectMongo, createMongoClient } from './mongodb.js';

interface BootstrapCliOptions {
  readonly applicationName: string;
  readonly bootstrapDirectory: string;
  readonly databaseNameEnvironmentVariable: string;
  readonly databaseUriEnvironmentVariable: string;
}

function requiredArgument(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = process.argv[index + 1];

  if (index === -1 || value === undefined || value.startsWith('--')) {
    throw new Error(`Missing required argument: ${flag}`);
  }

  return value;
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function parseArguments(): BootstrapCliOptions {
  return {
    applicationName: requiredArgument('--application-name'),
    bootstrapDirectory: resolve(process.cwd(), requiredArgument('--bootstrap')),
    databaseNameEnvironmentVariable: requiredArgument('--database-name-env'),
    databaseUriEnvironmentVariable: requiredArgument('--database-uri-env'),
  };
}

async function main(): Promise<void> {
  const options = parseArguments();
  const environment = parseCommonEnvironment();
  const logger = createLogger({
    serviceName: options.applicationName,
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const client = createMongoClient({
    uri: requiredEnvironmentVariable(options.databaseUriEnvironmentVariable),
    applicationName: options.applicationName,
  });

  try {
    await connectMongo(client);
    const result = await applyBootstrap(
      client.db(requiredEnvironmentVariable(options.databaseNameEnvironmentVariable)),
      options.bootstrapDirectory,
    );
    logger.info(result, 'MongoDB bootstrap completed');
  } finally {
    await closeMongo(client);
  }
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', message: 'MongoDB bootstrap failed', error: String(error) })}\n`,
  );
  process.exitCode = 1;
}
