CREATE TABLE orders (
    id UUID PRIMARY KEY,
    customer_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    currency CHAR(3) NOT NULL,
    total_cents BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT orders_customer_id_not_blank
        CHECK (customer_id = BTRIM(customer_id) AND customer_id <> ''),
    CONSTRAINT orders_status_valid
        CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    CONSTRAINT orders_currency_valid
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT orders_total_cents_non_negative
        CHECK (total_cents >= 0),
    CONSTRAINT orders_timestamps_ordered
        CHECK (updated_at >= created_at)
);

CREATE INDEX orders_customer_created_at_idx
    ON orders (customer_id, created_at DESC);

CREATE INDEX orders_status_created_at_idx
    ON orders (status, created_at);

CREATE TABLE order_items (
    order_id UUID NOT NULL,
    line_number SMALLINT NOT NULL,
    product_id VARCHAR(128) NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents BIGINT NOT NULL,

    CONSTRAINT order_items_pk
        PRIMARY KEY (order_id, line_number),
    CONSTRAINT order_items_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_line_number_positive
        CHECK (line_number > 0),
    CONSTRAINT order_items_product_id_not_blank
        CHECK (product_id = BTRIM(product_id) AND product_id <> ''),
    CONSTRAINT order_items_quantity_valid
        CHECK (quantity BETWEEN 1 AND 1000),
    CONSTRAINT order_items_unit_price_non_negative
        CHECK (unit_price_cents >= 0)
);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    event_version SMALLINT NOT NULL,
    payload JSONB NOT NULL,
    trace_context JSONB NOT NULL,
    correlation_id VARCHAR(128) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,

    CONSTRAINT outbox_events_order_fk
        FOREIGN KEY (aggregate_id) REFERENCES orders (id),
    CONSTRAINT outbox_events_type_not_blank
        CHECK (event_type = BTRIM(event_type) AND event_type <> ''),
    CONSTRAINT outbox_events_version_positive
        CHECK (event_version > 0),
    CONSTRAINT outbox_events_payload_object
        CHECK (JSONB_TYPEOF(payload) = 'object'),
    CONSTRAINT outbox_events_trace_context_object
        CHECK (JSONB_TYPEOF(trace_context) = 'object'),
    CONSTRAINT outbox_events_correlation_id_not_blank
        CHECK (correlation_id = BTRIM(correlation_id) AND correlation_id <> ''),
    CONSTRAINT outbox_events_attempts_non_negative
        CHECK (publish_attempts >= 0),
    CONSTRAINT outbox_events_published_after_occurrence
        CHECK (published_at IS NULL OR published_at >= occurred_at)
);

CREATE INDEX outbox_events_pending_idx
    ON outbox_events (next_attempt_at, occurred_at)
    WHERE published_at IS NULL;

CREATE INDEX outbox_events_aggregate_created_idx
    ON outbox_events (aggregate_id, occurred_at);
