# ADR 0003: MongoDB Document Model and Atomicity

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR 0002

## Context

The project now uses MongoDB instead of PostgreSQL while retaining the existing service boundaries, Redis cache, RabbitMQ delivery semantics, OpenTelemetry tracing, and resilience design. Persistence must remain reproducible, idempotent, and suitable for local development and CI.

## Decisions

### Driver and ownership

Use the official `mongodb` Node.js driver without an ODM. The Order Service owns `orders_db`; the Notification Service owns `notifications_db`. Both databases use the same local MongoDB deployment but services never read each other's collections.

### Order document and embedded outbox

An order is one document in `orders`, with line items embedded because they are created and read with the order aggregate. The UUID string is stored as `_id`, preserving the existing public ID without introducing `ObjectId` mapping.

The pending `order.created` outbox record is embedded in the order document. Creating the order and its unpublished event is therefore one atomic document insertion and needs no multi-document transaction. A partial index on the embedded outbox retry fields supports publisher polling. The publisher updates the embedded outbox state only after RabbitMQ publisher confirmation.

### Notification idempotency and transactions

The requested `processed_events` and `notifications` collections are separate documents. Maintaining an idempotency marker and its notification audit record atomically is not possible with a single-document write. MongoDB multi-document transactions are therefore required for this path.

Local Compose and disposable integration tests run a single-node replica set named `rs0`. The consumer inserts `processed_events` first inside the transaction. A unique `eventId` index is the idempotency gate. Duplicate deliveries are detected only by catching MongoDB error code `E11000`; there is no pre-read race. The notification audit insert occurs in the same transaction. Any audit validation or write failure rolls back the marker.

### Collections and indexes

- `orders`: implicit `_id` index for `GET /orders/:id`; compound customer/date and status/date indexes; partial embedded-outbox polling index.
- `processed_events`: unique `eventId` index plus order/date audit index.
- `notifications`: unique `eventId` defense-in-depth index plus order/date and customer/date audit indexes.
- `_bootstrap_versions`: records applied bootstrap filename, version, checksum, and timestamp.

Every application collection has an explicit MongoDB JSON Schema validator. Bootstrap files create collections deliberately; the system never relies on implicit collection creation.

### Versioned bootstrap

Service-owned `NNN_description.json` files declaratively define collections, validators, and named indexes. The shared bootstrap runner:

- Loads versions in lexical order.
- validates filenames and specification shape;
- creates missing collections explicitly;
- reapplies validators with `collMod`;
- creates named indexes idempotently;
- records SHA-256 checksums in `_bootstrap_versions`;
- rejects removed, modified, duplicated, or backfilled applied versions.

This is the MongoDB equivalent of forward-only schema migrations and is runnable through npm in local development and CI.

### Observability

Use `@opentelemetry/instrumentation-mongodb`. Enhanced database reporting is disabled to avoid attaching query values or sensitive document data to spans. The instrumentation is exported as a shared factory for later OpenTelemetry SDK initialization.

## Consequences

- Embedded order items and outbox data match aggregate access patterns and avoid an order-creation transaction.
- The notification path requires a replica set even for a single local node.
- Explicit validators and indexes retain reproducibility without SQL DDL.
- E11000-based idempotency is race-safe and directly exercised against a real disposable replica set.
- A document-size limit now applies to orders; the current maximum of 100 small items is comfortably below MongoDB's 16 MiB limit.
