# ADR 0001: Core Architecture

- Status: Accepted
- Date: 2026-09-11

## Context

This project is a resume-oriented TypeScript backend that must demonstrate independent services, asynchronous messaging, MongoDB persistence, Redis caching, JWT authentication, resilience, distributed tracing, container orchestration, and measurable load-test results. The design favors explicit behavior, reproducible demonstrations, and operational clarity over feature breadth.

## Decisions

### Service and repository structure

Use an npm-workspaces monorepo containing independently buildable and deployable Order and Notification services plus narrowly scoped shared packages. Each service will own its startup, configuration, health state, and shutdown lifecycle. Shared packages may contain contracts and cross-cutting utilities, but not service business logic.

Use Fastify for HTTP APIs. Its JSON-schema-based validation, lifecycle hooks, Pino logging integration, and low framework overhead are well suited to the validation, observability, graceful-shutdown, and benchmarking requirements.

### Persistence (superseded by ADR 0003)

Use the official MongoDB driver and explicit, versioned collection bootstrap specifications rather than an ODM. This keeps document validation, indexes, transactions, and query behavior visible. MongoDB is the source of truth. ADR 0003 records the current document model and supersedes the original PostgreSQL choice.

Use Redis as a cache-aside layer for order reads. Cache entries will be configurable so identical load-test scenarios can run with caching enabled and disabled. Redis failure will degrade reads to MongoDB rather than make the Order Service unavailable.

The detailed document model and atomicity decision are defined in ADR 0003. Orders embed line items and their outbox record; notification idempotency and audit documents use a replica-set transaction.

### Messaging

Use RabbitMQ rather than Redis Pub/Sub. RabbitMQ provides durable queues, consumer acknowledgements, publisher confirms, dead-letter exchanges, bounded retry queues, and redelivery semantics required by this project.

Order creation emits a versioned `order.created` event. Event envelopes will carry an event ID, correlation data, occurrence timestamp, schema version, payload, and OpenTelemetry propagation headers. Notification processing will be idempotent, acknowledge only completed or recognized duplicate work, retry transient failures a bounded number of times, and route exhausted or invalid messages to a terminal DLQ.

### Authentication and exposed HTTP APIs

The Order Service owns a mock login endpoint and signs short-lived JWTs using local demo credentials. A shared auth package verifies the same issuer, audience, algorithm, and claims in both services. Business and demo endpoints require bearer authentication; liveness and readiness endpoints remain unauthenticated for orchestration.

The Notification Service exposes a protected, read-only notification lookup endpoint so its JWT validation is directly demonstrable. Failure-simulation controls will also require authentication and will be disabled outside an explicit demo/test mode.

### Circuit breaker and retries

Normal notification delivery remains asynchronous through RabbitMQ. To demonstrate service-to-service resilience without coupling order creation to Notification Service availability, the Order Service will expose or invoke a separate synchronous delivery-status probe against the Notification Service. That call will use a strict timeout, bounded retries with exponential backoff and jitter, and a circuit breaker with visible open, half-open, recovered, rejected, and fallback behavior.

This probe is a demonstration path, not a prerequisite for accepting or publishing an order.

### Observability evidence

Both services will initialize OpenTelemetry before application modules and export OTLP traces to Jaeger. Trace context will cross RabbitMQ message boundaries so order creation, publishing, consumption, and simulated notification work can be followed as one distributed trace.

The repository will include a reproducible exported trace artifact when the stack is operational, along with instructions for viewing live traces in Jaeger. A UI screenshot may be included if it can be captured reliably, but the exported artifact is the durable evidence.

### Scope

Horizontal scaling behind a load balancer is excluded from the initial build. It remains a stretch goal that requires separate approval after the core system, tests, documentation, and baseline caching benchmarks are complete.

## Consequences

- The project shows document modeling, indexes, messaging topology, failure handling, and cache behavior directly rather than hiding them behind broad abstractions.
- Shared contracts reduce drift, while independent service entry points retain deployability boundaries.
- RabbitMQ adds operational complexity but enables meaningful acknowledgement, retry, and DLQ demonstrations that Redis Pub/Sub does not provide.
- A separate synchronous probe demonstrates circuit-breaking without compromising the asynchronous order workflow.
- The exported trace artifact provides reviewable evidence without making documentation depend on a manually maintained screenshot.
- Deferring horizontal scaling keeps the first implementation focused on correctness, resilience, observability, and measured cache performance.

## Deferred decisions

The following decisions belong to later TODO steps and will be finalized immediately before their implementation:

- Exact MongoDB repository query shapes and projections.
- RabbitMQ exchange, queue, retry-delay, retry-count, and DLQ names.
- Cache TTL and benchmark workload parameters.
- Concrete circuit-breaker thresholds and dependency-probe endpoint shape.
