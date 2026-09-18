import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type Db, type Document, MongoServerError } from 'mongodb';
import { z } from 'zod';

const BOOTSTRAP_FILENAME_PATTERN = /^(?<version>\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.json$/u;
const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const HISTORY_COLLECTION = '_bootstrap_versions';

const IndexDirectionSchema = z.union([
  z.literal(1),
  z.literal(-1),
  z.literal('2d'),
  z.literal('2dsphere'),
  z.literal('geoHaystack'),
  z.literal('hashed'),
  z.literal('text'),
]);

const BootstrapIndexSchema = z.object({
  name: z.string().regex(COLLECTION_NAME_PATTERN),
  key: z.record(z.string().min(1), IndexDirectionSchema),
  unique: z.boolean().optional(),
  partialFilterExpression: z.record(z.string(), z.unknown()).optional(),
});

const BootstrapCollectionSchema = z.object({
  name: z.string().regex(COLLECTION_NAME_PATTERN),
  validator: z.record(z.string(), z.unknown()).optional(),
  indexes: z.array(BootstrapIndexSchema).default([]),
});

const BootstrapSpecificationSchema = z.object({
  version: z.number().int().positive(),
  collections: z.array(BootstrapCollectionSchema).min(1),
});

export interface BootstrapFile {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
  readonly specification: z.infer<typeof BootstrapSpecificationSchema>;
}

export interface BootstrapResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface BootstrapHistoryDocument extends Document {
  readonly _id: number;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export class BootstrapValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BootstrapValidationError';
  }
}

async function collectionExists(database: Db, name: string): Promise<boolean> {
  return database.listCollections({ name }, { nameOnly: true }).hasNext();
}

async function createCollectionIfMissing(
  database: Db,
  name: string,
  validator?: Document,
): Promise<void> {
  if (!(await collectionExists(database, name))) {
    try {
      await database.createCollection(name, validator === undefined ? {} : { validator });
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 48) {
        throw error;
      }
    }
  }

  if (validator !== undefined) {
    await database.command({
      collMod: name,
      validator,
      validationAction: 'error',
      validationLevel: 'strict',
    });
  }
}

export async function loadBootstrapFiles(directory: string): Promise<readonly BootstrapFile[]> {
  const absoluteDirectory = resolve(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const seenVersions = new Set<number>();
  const files: BootstrapFile[] = [];

  for (const filename of filenames) {
    const versionText = BOOTSTRAP_FILENAME_PATTERN.exec(filename)?.groups?.version;

    if (versionText === undefined) {
      throw new BootstrapValidationError(
        `Invalid bootstrap filename ${filename}; expected NNN_description.json`,
      );
    }

    const version = Number(versionText);

    if (seenVersions.has(version)) {
      throw new BootstrapValidationError(`Duplicate bootstrap version: ${versionText}`);
    }

    seenVersions.add(version);
    const source = await readFile(resolve(absoluteDirectory, filename), 'utf8');
    const parsedJson: unknown = JSON.parse(source);
    const specification = BootstrapSpecificationSchema.parse(parsedJson);

    if (specification.version !== version) {
      throw new BootstrapValidationError(`Bootstrap version does not match filename: ${filename}`);
    }

    files.push({
      version,
      filename,
      checksum: createHash('sha256').update(source).digest('hex'),
      specification,
    });
  }

  return files;
}

export async function applyBootstrap(
  database: Db,
  bootstrapDirectory: string,
): Promise<BootstrapResult> {
  const files = await loadBootstrapFiles(bootstrapDirectory);
  await createCollectionIfMissing(database, HISTORY_COLLECTION);
  const history = database.collection<BootstrapHistoryDocument>(HISTORY_COLLECTION);
  const appliedHistory = await history.find().sort({ _id: 1 }).toArray();
  const localByVersion = new Map(files.map((file) => [file.version, file]));

  for (const applied of appliedHistory) {
    const local = localByVersion.get(applied._id);

    if (local === undefined) {
      throw new BootstrapValidationError(
        `Applied bootstrap is missing locally: ${applied.filename}`,
      );
    }

    if (local.filename !== applied.filename || local.checksum !== applied.checksum) {
      throw new BootstrapValidationError(`Applied bootstrap checksum changed: ${applied.filename}`);
    }
  }

  const appliedVersions = new Set(appliedHistory.map((entry) => entry._id));
  const lastAppliedVersion = appliedHistory.at(-1)?._id;
  const pending = files.filter((file) => !appliedVersions.has(file.version));

  if (
    lastAppliedVersion !== undefined &&
    pending.some((file) => file.version < lastAppliedVersion)
  ) {
    throw new BootstrapValidationError(
      'A pending bootstrap predates an applied version; bootstraps must be append-only',
    );
  }

  const applied: string[] = [];

  for (const file of pending) {
    for (const collection of file.specification.collections) {
      await createCollectionIfMissing(database, collection.name, collection.validator);

      if (collection.indexes.length > 0) {
        await database.collection(collection.name).createIndexes(
          collection.indexes.map((index) => ({
            key: index.key,
            name: index.name,
            ...(index.unique === undefined ? {} : { unique: index.unique }),
            ...(index.partialFilterExpression === undefined
              ? {}
              : { partialFilterExpression: index.partialFilterExpression }),
          })),
        );
      }
    }

    try {
      await history.insertOne({
        _id: file.version,
        filename: file.filename,
        checksum: file.checksum,
        appliedAt: new Date(),
      });
      applied.push(file.filename);
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11_000) {
        throw error;
      }

      const concurrent = await history.findOne({ _id: file.version });

      if (concurrent?.filename !== file.filename || concurrent.checksum !== file.checksum) {
        throw new BootstrapValidationError(
          `Concurrent bootstrap version conflict: ${file.filename}`,
        );
      }
    }
  }

  return {
    applied,
    skipped: files.filter((file) => appliedVersions.has(file.version)).map((file) => file.filename),
  };
}
