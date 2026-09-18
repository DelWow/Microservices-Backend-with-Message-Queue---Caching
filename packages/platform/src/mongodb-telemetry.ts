import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';

export function createMongoDbInstrumentation(): MongoDBInstrumentation {
  return new MongoDBInstrumentation({
    enhancedDatabaseReporting: false,
  });
}
