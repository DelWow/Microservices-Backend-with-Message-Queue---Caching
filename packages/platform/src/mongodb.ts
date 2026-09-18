import {
  MongoClient,
  MongoServerError,
  type ClientSession,
  type MongoClientOptions,
} from 'mongodb';

export interface CreateMongoClientOptions {
  readonly uri: string;
  readonly applicationName: string;
  readonly maxPoolSize?: number;
  readonly minPoolSize?: number;
  readonly serverSelectionTimeoutMs?: number;
}

export interface MongoReadiness {
  readonly latencyMs: number;
}

export function createMongoClient(options: CreateMongoClientOptions): MongoClient {
  const clientOptions: MongoClientOptions = {
    appName: options.applicationName,
    maxPoolSize: options.maxPoolSize ?? 10,
    minPoolSize: options.minPoolSize ?? 0,
    retryReads: true,
    retryWrites: true,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 5_000,
  };

  return new MongoClient(options.uri, clientOptions);
}

export async function connectMongo(client: MongoClient): Promise<MongoClient> {
  await client.connect();
  return client;
}

export async function closeMongo(client: MongoClient): Promise<void> {
  await client.close();
}

export async function checkMongoReadiness(client: MongoClient): Promise<MongoReadiness> {
  const startedAt = performance.now();
  await client.db('admin').command({ ping: 1 });
  return { latencyMs: performance.now() - startedAt };
}

export async function withMongoTransaction<Result>(
  client: MongoClient,
  operation: (session: ClientSession) => Promise<Result>,
): Promise<Result> {
  const session = client.startSession();
  let result!: Result;

  try {
    await session.withTransaction(
      async () => {
        result = await operation(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      },
    );

    return result;
  } finally {
    await session.endSession();
  }
}

export function isMongoDuplicateKeyError(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}
