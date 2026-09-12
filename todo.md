# Microservices Backend — Implementation TODO

> Status: core architecture confirmed. Step 2 implementation may begin on the next instruction.
>
> Working rule: keep all changes unstaged and uncommitted; do not run `git add`, `git commit`, or `git push` unless explicitly requested.

## 1. Confirm architecture and project scope

- [x] Read the supplied project brief and constraints.
- [x] Inspect the project directory for existing files and repository state.
- [x] Confirm RabbitMQ or Redis Pub/Sub as the message queue.
  - Decision: RabbitMQ, because durable queues, acknowledgements, bounded retry queues, publisher confirms, and dead-letter routing directly support the reliability requirements.
- [x] Confirm the HTTP framework (recommended: Fastify; alternative: Express).
  - Decision: Fastify, because its schema-first validation, structured Pino logging, lifecycle hooks, and low overhead fit the API and load-testing goals.
- [x] Confirm the database access layer (recommended: `pg` with explicit SQL; alternative: Prisma).
  - Decision: use `pg` with explicit, versioned SQL migrations to keep database behavior visible and demonstrate PostgreSQL skills without ORM abstraction.
- [x] Confirm the monorepo/package manager approach (recommended: npm workspaces).
  - Decision: use npm workspaces with independently buildable/deployable service packages and focused shared packages.
- [x] Confirm the JWT ownership model (recommended: mock login in Order Service with shared verification middleware in both services).
  - Decision: the Order Service owns the mock login endpoint; both services use shared JWT verification and authorization code. Health endpoints remain unauthenticated.
- [x] Confirm whether Notification Service should expose only operational/demo endpoints or also a protected business endpoint to visibly demonstrate JWT validation.
  - Decision: expose a protected read-only notification lookup endpoint in addition to public operational health endpoints.
- [x] Confirm whether the circuit breaker should protect an Order Service → Notification Service synchronous demo call while normal notification delivery remains asynchronous.
  - Decision: protect a deliberately separate synchronous delivery-status probe with retries and a circuit breaker; normal order notification delivery remains asynchronous through RabbitMQ.
- [x] Confirm whether an exported Jaeger trace JSON file is acceptable in lieu of a manually captured UI screenshot.
  - Decision: store an exported, reproducible trace artifact and document how to inspect live traces in Jaeger; add a UI screenshot only if it can be captured reliably after the stack is running.
- [x] Confirm that the stretch goal is excluded from the initial implementation.
  - Decision: horizontal scaling is excluded until separately approved after the core project is complete.
- [x] Record all confirmed architecture decisions in an ADR or README section.
  - Recorded in `docs/adr/0001-core-architecture.md`.
- [x] Get explicit approval to begin implementation.
  - Approval recorded from the instruction to complete all of Step 1; implementation starts with Step 2 on the next instruction.

## 2. Scaffold the TypeScript monorepo

- [x] Create the root `package.json` with npm workspaces.
- [x] Add root scripts for build, lint, type-check, test, and coverage.
- [x] Create a strict shared TypeScript configuration.
- [x] Configure ESLint for TypeScript.
- [x] Configure Prettier and formatting exclusions.
- [ ] Configure the test runner and coverage thresholds.
- [ ] Create workspace directories for Order Service, Notification Service, and shared packages.
- [x] Add `.gitignore` entries for dependencies, builds, coverage, logs, secrets, and load-test output.
- [ ] Add `.env.example` with documented non-secret local defaults.
- [ ] Add a root license if requested.
- [x] Verify dependency installation succeeds.
- [ ] Verify the empty workspace builds, lints, and type-checks.

## 3. Define shared contracts and infrastructure helpers

- [ ] Define the versioned `order.created` event schema.
- [ ] Include event ID, event version, order ID, occurred-at timestamp, trace context, and payload in the event envelope.
- [ ] Add runtime validation for event payloads.
- [ ] Define shared order domain types and API response types.
- [ ] Define a consistent structured error response shape.
- [ ] Implement shared environment-variable parsing and validation.
- [ ] Implement shared structured logger configuration with request/correlation IDs.
- [ ] Implement shared JWT signing/verification configuration.
- [ ] Implement reusable bearer-token validation middleware.
- [ ] Add unit tests for shared schema validation.
- [ ] Add unit tests for environment validation.
- [ ] Add unit tests for JWT middleware and failure cases.

## 4. Design and initialize PostgreSQL

- [ ] Document the proposed relational schema before implementing it.
- [ ] Create the `orders` table migration.
- [ ] Add appropriate primary key, timestamps, status constraint, and indexes.
- [ ] Create the notification processed-events/idempotency table migration.
- [ ] Add a unique event ID constraint for duplicate protection.
- [ ] Create a notification-attempts or notification-results table if confirmed.
- [ ] Add a migration runner suitable for local development and CI.
- [ ] Add seed data or a deterministic seed script for load testing.
- [ ] Add database connection-pool helpers.
- [ ] Add tests for migrations against a disposable PostgreSQL instance.
- [ ] Verify migrations are repeatable from a clean database.

## 5. Build the Order Service core

- [ ] Create the Order Service application factory separately from process startup.
- [ ] Add request IDs and structured request logging.
- [ ] Implement the protected mock login endpoint and deterministic demo credentials.
- [ ] Implement authenticated `POST /orders` request validation.
- [ ] Implement the PostgreSQL order repository create operation.
- [ ] Implement authenticated `GET /orders/:id` request validation.
- [ ] Implement the PostgreSQL order repository read operation.
- [ ] Return consistent 400, 401, 404, and 500 responses.
- [ ] Add unit tests for order request validation.
- [ ] Add unit tests for order service business logic.
- [ ] Add API tests for login success and failure.
- [ ] Add API tests for create-order authentication and validation.
- [ ] Add API tests for fetch-order authentication and not-found behavior.
- [ ] Run and report the Order Service test count.
- [ ] Pause for an Order Service milestone review.

## 6. Add Redis caching to Order Service

- [ ] Create a Redis client with explicit connection and shutdown handling.
- [ ] Define namespaced, versioned cache keys.
- [ ] Make cache TTL configurable with a sensible default.
- [ ] Implement cache-aside reads for `GET /orders/:id`.
- [ ] Populate or invalidate the cache after successful order creation.
- [ ] Add a configuration switch to disable caching for benchmark parity.
- [ ] Define safe behavior when Redis is unavailable (fall back to PostgreSQL).
- [ ] Add cache hit/miss/bypass metadata to structured logs.
- [ ] Add unit tests for cache hit, miss, expiry assumptions, and bypass paths.
- [ ] Add integration tests for cached reads and Redis failure fallback.
- [ ] Verify no stale data is returned after writes.
- [ ] Pause for a caching milestone review.

## 7. Add RabbitMQ publishing and reliable event topology

- [ ] Define exchange, routing key, durable queue, retry queues, and DLQ names.
- [ ] Document retry-count and backoff behavior.
- [ ] Create a RabbitMQ connection/channel manager with reconnect handling.
- [ ] Declare durable exchange and queues idempotently at startup.
- [ ] Bind the notification queue to `order.created` events.
- [ ] Configure dead-letter routing for retry queues and the terminal DLQ.
- [ ] Publish persistent events only after the order transaction succeeds.
- [ ] Propagate correlation and OpenTelemetry trace context in message headers.
- [ ] Use publisher confirms and handle negative acknowledgements/timeouts.
- [ ] Add tests for event construction and routing metadata.
- [ ] Add an integration test proving order creation publishes an event.
- [ ] Document the consistency limitation or implement an outbox if explicitly chosen.

## 8. Build the Notification Service consumer

- [ ] Create the Notification Service application factory separately from process startup.
- [ ] Add protected business/demo endpoint(s) if confirmed.
- [ ] Start the RabbitMQ consumer only after dependencies are ready.
- [ ] Validate incoming event envelopes and supported versions.
- [ ] Implement simulated notification delivery with structured logs.
- [ ] Make event handling idempotent using the unique processed-event record.
- [ ] Ensure the notification action and idempotency record have safe transaction semantics.
- [ ] Acknowledge messages only after successful processing.
- [ ] Detect duplicate deliveries and acknowledge them without duplicate notification work.
- [ ] Add configurable failure, delay, and poison-message simulation controls.
- [ ] Route retryable failures through bounded retry queues.
- [ ] Route exhausted or invalid/poison messages to the terminal DLQ.
- [ ] Record retry attempt and failure reason in logs and headers.
- [ ] Add unit tests for successful consumption.
- [ ] Add unit tests for duplicate event handling.
- [ ] Add unit tests for retry classification and exhaustion.
- [ ] Add an integration test proving a created order is consumed once.
- [ ] Add an integration test proving a poison message reaches the DLQ.
- [ ] Run and report the Notification Service test count.
- [ ] Pause for a messaging and Notification Service milestone review.

## 9. Add circuit breaker and retry demonstration

- [ ] Finalize the synchronous dependency call used for the resilience demo.
- [ ] Implement bounded retries with exponential backoff and jitter.
- [ ] Wrap the dependency call in a circuit breaker with configurable thresholds.
- [ ] Define timeout, open, half-open, close, reject, and fallback behavior.
- [ ] Emit structured logs for every circuit-breaker state transition.
- [ ] Add a protected failure-mode control or environment flag to simulate slow/failing responses.
- [ ] Prevent demo controls from being enabled accidentally in production mode.
- [ ] Add unit tests for retry timing using fake timers.
- [ ] Add unit tests for open, half-open, and recovery behavior.
- [ ] Add an integration/demo script that trips and recovers the breaker.
- [ ] Verify the async order event path remains independent of the synchronous demo dependency.
- [ ] Pause for a resilience milestone review.

## 10. Add health checks and graceful shutdown

- [ ] Implement `/healthz` liveness on Order Service.
- [ ] Implement `/readyz` readiness checks for Order Service dependencies.
- [ ] Implement `/healthz` liveness on Notification Service.
- [ ] Implement `/readyz` readiness checks for Notification Service dependencies.
- [ ] Return dependency-specific readiness details without leaking secrets.
- [ ] Track in-flight HTTP requests during shutdown.
- [ ] Stop accepting new HTTP requests on SIGTERM/SIGINT.
- [ ] Stop or cancel message consumption before closing the broker channel.
- [ ] Allow in-flight message handling to finish within a configured deadline.
- [ ] Close PostgreSQL, Redis, RabbitMQ, and telemetry resources in safe order.
- [ ] Force exit with an error after the shutdown deadline if cleanup hangs.
- [ ] Add tests for liveness and readiness state changes.
- [ ] Add tests for shutdown ordering.
- [ ] Add a demo script/check showing an in-flight message is not lost during shutdown.
- [ ] Pause for an operations milestone review.

## 11. Add end-to-end OpenTelemetry tracing

- [ ] Add OpenTelemetry SDK initialization before application imports.
- [ ] Configure service names and resource attributes for both services.
- [ ] Instrument inbound/outbound HTTP, PostgreSQL, Redis, and RabbitMQ operations.
- [ ] Export OTLP traces to the configured collector/Jaeger endpoint.
- [ ] Create spans for order creation, event publishing, consumption, and notification work.
- [ ] Extract the producer trace context when consuming a message.
- [ ] Ensure the consumer span links or continues the originating trace correctly.
- [ ] Include trace/span IDs in structured logs.
- [ ] Add tests for message trace-header inject/extract helpers.
- [ ] Verify one order request is visible end-to-end in Jaeger.
- [ ] Export a representative trace artifact or capture a README screenshot.
- [ ] Pause for an observability milestone review.

## 12. Create local Docker orchestration

- [ ] Write production-like multi-stage Dockerfiles for both services.
- [ ] Add `.dockerignore` files.
- [ ] Define PostgreSQL with persistent storage and a health check.
- [ ] Define Redis with persistent storage and a health check.
- [ ] Define RabbitMQ with the management UI, persistent storage, and a health check.
- [ ] Define Jaeger with OTLP ingestion and its UI port.
- [ ] Define Order Service with dependency conditions and a real HTTP health check.
- [ ] Define Notification Service with dependency conditions and a real HTTP health check.
- [ ] Pass configuration via Compose environment variables without embedding real secrets.
- [ ] Add named networks and volumes.
- [ ] Confirm `docker compose config` is valid.
- [ ] Confirm a clean `docker compose up --build` reaches healthy state.
- [ ] Confirm `docker compose ps` reflects service readiness accurately.
- [ ] Confirm data survives ordinary container recreation.

## 13. Expand automated testing to a resume-ready suite

- [ ] Add repository unit tests for successful and failure paths.
- [ ] Add authentication edge-case tests.
- [ ] Add cache behavior and fallback tests.
- [ ] Add messaging serialization and validation tests.
- [ ] Add idempotency and duplicate-delivery tests.
- [ ] Add retry, DLQ, and poison-message tests.
- [ ] Add circuit-breaker transition tests.
- [ ] Add health/readiness tests.
- [ ] Add graceful-shutdown tests.
- [ ] Add trace-propagation tests.
- [ ] Add cross-service integration tests using real infrastructure.
- [ ] Add at least one end-to-end order-to-notification test.
- [ ] Reach at least 40 meaningful passing tests without padding with trivial cases.
- [ ] Run the entire test suite from a clean state.
- [ ] Record the exact passing test count and duration.
- [ ] Review coverage output and close material gaps in critical paths.

## 14. Add CI workflow

- [ ] Create a GitHub Actions workflow triggered on pushes and pull requests.
- [ ] Pin the Node.js major version used by the project.
- [ ] Cache npm dependencies safely.
- [ ] Start required PostgreSQL, Redis, and RabbitMQ service containers.
- [ ] Wait for service-container readiness before integration tests.
- [ ] Run deterministic dependency installation.
- [ ] Run formatting check.
- [ ] Run linting.
- [ ] Run TypeScript type-checking.
- [ ] Run unit and integration tests with coverage.
- [ ] Run application builds.
- [ ] Upload coverage/test artifacts where useful.
- [ ] Validate workflow YAML locally where tooling permits.

## 15. Build reproducible demos

- [ ] Add a script to obtain a JWT and create an order.
- [ ] Add a script to fetch an order repeatedly and expose cache-hit behavior.
- [ ] Add a script to publish or create a poison event.
- [ ] Add a script to inspect the DLQ safely.
- [ ] Add a script to trigger circuit-breaker failure mode.
- [ ] Add a script to demonstrate circuit-breaker recovery.
- [ ] Add a script/check for graceful shutdown with in-flight work.
- [ ] Make all demo scripts fail fast with actionable messages.
- [ ] Verify every documented demo from a clean Compose startup.

## 16. Create and run the k6 load test

- [ ] Create a deterministic setup step that seeds or creates the benchmark order.
- [ ] Create a k6 scenario for authenticated `GET /orders/:id` traffic.
- [ ] Parameterize base URL, JWT, virtual users, duration, and cache mode.
- [ ] Define latency and failure-rate thresholds.
- [ ] Add a cache-disabled benchmark command/profile.
- [ ] Add a cache-enabled benchmark command/profile.
- [ ] Warm the cache explicitly before the cached measurement.
- [ ] Keep dataset, hardware, virtual users, and duration identical between runs.
- [ ] Capture p50, p95, p99 latency, request rate, and error rate for both runs.
- [ ] Save raw k6 summaries as project artifacts.
- [ ] Calculate absolute and percentage latency/throughput differences.
- [ ] Repeat runs enough times to avoid presenting a one-off result.
- [ ] Document the local machine/environment and methodology.
- [ ] Pause after presenting actual benchmark results for review.

## 17. Write project documentation

- [ ] Write a concise project overview and feature list.
- [ ] Add a Mermaid architecture diagram.
- [ ] Document the HTTP request, database, cache, and event flows.
- [ ] Document prerequisites and exact local startup commands.
- [ ] Document environment variables and safe demo defaults.
- [ ] Document mock login credentials and API examples.
- [ ] Document migrations and seed commands.
- [ ] Document health/readiness URLs and expected responses.
- [ ] Document RabbitMQ management and Jaeger UI URLs.
- [ ] Document the circuit-breaker trip/recovery demo.
- [ ] Document the poison-message and DLQ demo.
- [ ] Document graceful-shutdown behavior and demo steps.
- [ ] Embed or link the verified end-to-end trace example.
- [ ] Add the measured cache-disabled versus cache-enabled results table.
- [ ] Explain benchmark methodology and limitations honestly.
- [ ] Add the exact automated test count and CI commands.
- [ ] Add troubleshooting guidance for common Docker/port issues.
- [ ] Add 5–6 resume-ready bullets grounded in verified project metrics.

## 18. Final verification and handoff

- [ ] Run formatting across the repository.
- [ ] Run linting with zero errors.
- [ ] Run TypeScript type-checking with zero errors.
- [ ] Run all tests and record the final passing count.
- [ ] Build all workspaces successfully.
- [ ] Start the full stack from a clean state.
- [ ] Verify login, create order, fetch order, cache hit, and notification flow.
- [ ] Verify duplicate delivery does not duplicate notification work.
- [ ] Verify bounded retries and terminal DLQ routing.
- [ ] Verify circuit breaker opens and recovers.
- [ ] Verify a cross-service trace appears in Jaeger.
- [ ] Verify both services report liveness and readiness correctly.
- [ ] Verify graceful shutdown does not corrupt or silently drop in-flight work.
- [ ] Re-run and preserve final load-test measurements.
- [ ] Review documentation commands against the actual project.
- [ ] Review `git diff`/working files without staging anything.
- [ ] Confirm no secrets, generated dependency directories, or large unintended artifacts are present.
- [ ] Deliver a final implementation summary, known limitations, test count, metrics, and resume bullets.

## 19. Stretch goal — only after separate approval

- [ ] Ask for explicit approval before beginning horizontal-scaling work.
- [ ] Add nginx or Traefik as a local load balancer.
- [ ] Make the Order Service stateless across replicas.
- [ ] Add Compose profiles or documented commands for 1, 2, and 3 replicas.
- [ ] Verify load balancing and health-aware routing.
- [ ] Run identical load tests at 1, 2, and 3 replicas.
- [ ] Save raw results and calculate scaling efficiency.
- [ ] Add a simple comparison chart/table to the README.
- [ ] Document bottlenecks and why scaling may not be linear.
