import { EventEmitter } from 'node:events';

import type {
  ChannelModel,
  ConfirmChannel,
  RecoveringChannelModel,
  RecoveryOptions,
} from 'amqplib';
import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  assertRabbitMqTopology,
  NOTIFICATION_DEAD_LETTER_EXCHANGE,
  NOTIFICATION_DEAD_LETTER_QUEUE,
  NOTIFICATION_DEAD_LETTER_ROUTING_KEY,
  NOTIFICATION_QUEUE,
  NOTIFICATION_RETRY_EXCHANGE,
  NOTIFICATION_RETRY_STAGES,
  ORDER_CREATED_ROUTING_KEY,
  ORDER_EVENTS_EXCHANGE,
  RabbitMqConnectionManager,
  type RabbitMqConnector,
  type RabbitMqLogger,
  type RabbitMqTopologyChannel,
} from '../packages/platform/src/index.js';

function createTopologyChannel(): {
  readonly assertExchange: Mock<RabbitMqTopologyChannel['assertExchange']>;
  readonly assertQueue: Mock<RabbitMqTopologyChannel['assertQueue']>;
  readonly bindQueue: Mock<RabbitMqTopologyChannel['bindQueue']>;
  readonly channel: RabbitMqTopologyChannel;
} {
  const assertExchange = vi
    .fn<RabbitMqTopologyChannel['assertExchange']>()
    .mockImplementation((exchange) => Promise.resolve({ exchange }));
  const assertQueue = vi
    .fn<RabbitMqTopologyChannel['assertQueue']>()
    .mockImplementation((queue) => Promise.resolve({ queue, messageCount: 0, consumerCount: 0 }));
  const bindQueue = vi.fn<RabbitMqTopologyChannel['bindQueue']>().mockResolvedValue({});
  return {
    assertExchange,
    assertQueue,
    bindQueue,
    channel: { assertExchange, assertQueue, bindQueue },
  };
}

function createLogger(): {
  readonly error: Mock<RabbitMqLogger['error']>;
  readonly info: Mock<RabbitMqLogger['info']>;
  readonly logger: RabbitMqLogger;
  readonly warn: Mock<RabbitMqLogger['warn']>;
} {
  const error = vi.fn<RabbitMqLogger['error']>();
  const info = vi.fn<RabbitMqLogger['info']>();
  const warn = vi.fn<RabbitMqLogger['warn']>();
  return { error, info, logger: { error, info, warn }, warn };
}

describe('RabbitMQ topology', () => {
  it('declares durable exchanges, queues, bindings, retries, and the terminal DLQ', async () => {
    const fixture = createTopologyChannel();

    await assertRabbitMqTopology(fixture.channel);

    expect(fixture.assertExchange).toHaveBeenCalledWith(ORDER_EVENTS_EXCHANGE, 'topic', {
      autoDelete: false,
      durable: true,
    });
    expect(fixture.assertExchange).toHaveBeenCalledWith(NOTIFICATION_RETRY_EXCHANGE, 'direct', {
      autoDelete: false,
      durable: true,
    });
    expect(fixture.assertExchange).toHaveBeenCalledWith(
      NOTIFICATION_DEAD_LETTER_EXCHANGE,
      'direct',
      { autoDelete: false, durable: true },
    );
    expect(fixture.assertQueue).toHaveBeenCalledWith(NOTIFICATION_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': NOTIFICATION_DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': NOTIFICATION_DEAD_LETTER_ROUTING_KEY,
      },
    });
    expect(fixture.bindQueue).toHaveBeenCalledWith(
      NOTIFICATION_QUEUE,
      ORDER_EVENTS_EXCHANGE,
      ORDER_CREATED_ROUTING_KEY,
    );

    for (const stage of NOTIFICATION_RETRY_STAGES) {
      expect(fixture.assertQueue).toHaveBeenCalledWith(stage.queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': ORDER_EVENTS_EXCHANGE,
          'x-dead-letter-routing-key': ORDER_CREATED_ROUTING_KEY,
          'x-message-ttl': stage.delayMs,
        },
      });
      expect(fixture.bindQueue).toHaveBeenCalledWith(
        stage.queue,
        NOTIFICATION_RETRY_EXCHANGE,
        stage.routingKey,
      );
    }

    expect(fixture.assertQueue).toHaveBeenCalledWith(NOTIFICATION_DEAD_LETTER_QUEUE, {
      durable: true,
    });
    expect(fixture.bindQueue).toHaveBeenCalledWith(
      NOTIFICATION_DEAD_LETTER_QUEUE,
      NOTIFICATION_DEAD_LETTER_EXCHANGE,
      NOTIFICATION_DEAD_LETTER_ROUTING_KEY,
    );
  });

  it('uses a bounded three-stage retry policy with increasing delays', () => {
    expect(NOTIFICATION_RETRY_STAGES.map(({ attempt, delayMs }) => ({ attempt, delayMs }))).toEqual(
      [
        { attempt: 1, delayMs: 1_000 },
        { attempt: 2, delayMs: 5_000 },
        { attempt: 3, delayMs: 30_000 },
      ],
    );
    expect(new Set(NOTIFICATION_RETRY_STAGES.map((stage) => stage.queue)).size).toBe(3);
  });
});

describe('RabbitMqConnectionManager', () => {
  it('creates a confirm channel, reruns setup after disconnect, and closes cleanly', async () => {
    const channelClose = vi.fn().mockResolvedValue(undefined);
    const channel = Object.assign(new EventEmitter(), {
      close: channelClose,
    }) as unknown as ConfirmChannel;
    const createConfirmChannel = vi.fn().mockResolvedValue(channel);
    const model = { createConfirmChannel } as unknown as ChannelModel;
    const connectionClose = vi.fn().mockResolvedValue(undefined);
    const connection = Object.assign(new EventEmitter(), {
      close: connectionClose,
    }) as unknown as RecoveringChannelModel;
    let recoverySetup: ((model: ChannelModel) => Promise<void>) | undefined;
    const connector = vi.fn<RabbitMqConnector>().mockImplementation((_url, options) => {
      recoverySetup = options.recovery.setup as (model: ChannelModel) => Promise<void>;
      return recoverySetup(model).then(() => connection);
    });
    const setupChannel = vi.fn<(channel: ConfirmChannel) => Promise<void>>().mockResolvedValue();
    const { info, logger, warn } = createLogger();
    const manager = new RabbitMqConnectionManager(
      { logger, setupChannel, url: 'amqp://app:app@localhost:5672' },
      { connector },
    );

    expect(() => manager.channel).toThrow('RabbitMQ confirm channel is not ready');
    await manager.connect();
    expect(manager.isReady).toBe(true);
    expect(manager.channel).toBe(channel);
    expect(setupChannel).toHaveBeenCalledWith(channel);
    expect(info).toHaveBeenCalledWith({}, 'RabbitMQ confirm channel ready');

    const disconnectError = new Error('socket closed');
    connection.emit('disconnect', disconnectError);
    expect(manager.isReady).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { err: disconnectError },
      'RabbitMQ disconnected; recovery scheduled',
    );

    if (recoverySetup === undefined) {
      throw new Error('Recovery setup callback was not registered');
    }

    await recoverySetup(model);
    expect(manager.isReady).toBe(true);
    expect(createConfirmChannel).toHaveBeenCalledTimes(2);

    await expect(manager.connect()).rejects.toThrow(
      'RabbitMQ connection manager is already connected',
    );
    await manager.close();
    expect(manager.isReady).toBe(false);
    expect(channelClose).toHaveBeenCalledOnce();
    expect(connectionClose).toHaveBeenCalledOnce();
  });

  it('uses bounded exponential reconnect defaults and logs recovery failures', async () => {
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ConfirmChannel;
    const model = {
      createConfirmChannel: vi.fn().mockResolvedValue(channel),
    } as unknown as ChannelModel;
    const connection = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as RecoveringChannelModel;
    let recoveryOptions: RecoveryOptions | undefined;
    const connector = vi.fn<RabbitMqConnector>().mockImplementation((_url, options) => {
      recoveryOptions = options.recovery;
      const setup = options.recovery.setup as (model: ChannelModel) => Promise<void>;
      return setup(model).then(() => connection);
    });
    const { error, logger, warn } = createLogger();
    const manager = new RabbitMqConnectionManager(
      {
        logger,
        setupChannel: () => Promise.resolve(),
        url: 'amqp://localhost',
      },
      { connector },
    );

    await manager.connect();
    expect(recoveryOptions).toMatchObject({
      factor: 2,
      initialDelay: 200,
      jitter: 0.2,
      maxDelay: 5_000,
      maxRetries: Number.POSITIVE_INFINITY,
    });
    const reconnectError = new Error('still unavailable');
    connection.emit('reconnect-scheduled', {
      attempt: 2,
      delay: 400,
      error: reconnectError,
    });
    connection.emit('reconnect-failed', reconnectError);

    expect(warn).toHaveBeenCalledWith(
      { attempt: 2, delayMs: 400, err: reconnectError },
      'RabbitMQ reconnect scheduled',
    );
    expect(error).toHaveBeenCalledWith(
      { err: reconnectError },
      'RabbitMQ reconnect attempts exhausted',
    );
    await manager.close();
  });
});
