CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(128) NOT NULL,
    event_version SMALLINT NOT NULL,
    order_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT processed_events_type_not_blank
        CHECK (event_type = BTRIM(event_type) AND event_type <> ''),
    CONSTRAINT processed_events_version_positive
        CHECK (event_version > 0)
);

CREATE INDEX processed_events_order_processed_at_idx
    ON processed_events (order_id, processed_at DESC);

CREATE INDEX processed_events_processed_at_idx
    ON processed_events (processed_at);

CREATE TABLE notifications (
    id UUID PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    order_id UUID NOT NULL,
    customer_id VARCHAR(128) NOT NULL,
    channel VARCHAR(32) NOT NULL DEFAULT 'log',
    status VARCHAR(32) NOT NULL DEFAULT 'sent',
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT notifications_processed_event_fk
        FOREIGN KEY (event_id) REFERENCES processed_events (event_id),
    CONSTRAINT notifications_customer_id_not_blank
        CHECK (customer_id = BTRIM(customer_id) AND customer_id <> ''),
    CONSTRAINT notifications_channel_valid
        CHECK (channel IN ('log')),
    CONSTRAINT notifications_status_valid
        CHECK (status IN ('sent')),
    CONSTRAINT notifications_message_not_blank
        CHECK (BTRIM(message) <> '')
);

CREATE INDEX notifications_order_created_at_idx
    ON notifications (order_id, created_at DESC);

CREATE INDEX notifications_customer_created_at_idx
    ON notifications (customer_id, created_at DESC);
