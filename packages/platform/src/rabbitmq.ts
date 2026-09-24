import {
  connect as connectAmqp,
  type ChannelModel,
  type ConfirmChannel,
  type RecoveringChannelModel,
  type RecoveryOptions,
  type SocketOptions,
} from 'amqplib';

export interface RabbitMqLogger {
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface RabbitMqConnectionManagerOptions {
  readonly logger: RabbitMqLogger;
  readonly recovery?: {
    readonly factor?: number;
    readonly initialDelayMs?: number;
    readonly jitter?: number;
    readonly maxDelayMs?: number;
    readonly maxRetries?: number;
  };
  readonly setupChannel: (channel: ConfirmChannel) => Promise<void>;
  readonly url: string;
}

export type RabbitMqConnector = (
  url: string,
  options: SocketOptions & { recovery: RecoveryOptions },
) => Promise<RecoveringChannelModel>;

export interface RabbitMqConnectionManagerDependencies {
  readonly connector?: RabbitMqConnector;
}

export class RabbitMqConnectionManager {
  readonly #connector: RabbitMqConnector;
  readonly #options: RabbitMqConnectionManagerOptions;
  #channel: ConfirmChannel | undefined;
  #connection: RecoveringChannelModel | undefined;
  #ready = false;

  public constructor(
    options: RabbitMqConnectionManagerOptions,
    dependencies: RabbitMqConnectionManagerDependencies = {},
  ) {
    this.#options = options;
    this.#connector = dependencies.connector ?? connectAmqp;
  }

  public get isReady(): boolean {
    return this.#ready;
  }

  public get channel(): ConfirmChannel {
    if (this.#channel === undefined || !this.#ready) {
      throw new Error('RabbitMQ confirm channel is not ready');
    }

    return this.#channel;
  }

  public async connect(): Promise<void> {
    if (this.#connection !== undefined) {
      throw new Error('RabbitMQ connection manager is already connected');
    }

    const recovery = this.#options.recovery;
    const connection = await this.#connector(this.#options.url, {
      recovery: {
        factor: recovery?.factor ?? 2,
        initialDelay: recovery?.initialDelayMs ?? 200,
        jitter: recovery?.jitter ?? 0.2,
        maxDelay: recovery?.maxDelayMs ?? 5_000,
        maxRetries: recovery?.maxRetries ?? Number.POSITIVE_INFINITY,
        setup: async (model: ChannelModel): Promise<void> => {
          const channel = await model.createConfirmChannel();
          channel.on('error', (error: Error) => {
            this.#options.logger.error({ err: error }, 'RabbitMQ channel error');
          });
          channel.on('handler-error', (error: Error, eventName: string) => {
            this.#options.logger.error(
              { err: error, eventName },
              'RabbitMQ channel event handler failed',
            );
          });
          await this.#options.setupChannel(channel);
          this.#channel = channel;
          this.#ready = true;
          this.#options.logger.info({}, 'RabbitMQ confirm channel ready');
        },
      },
    });

    connection.on('disconnect', (error) => {
      this.#channel = undefined;
      this.#ready = false;
      this.#options.logger.warn({ err: error }, 'RabbitMQ disconnected; recovery scheduled');
    });
    connection.on('reconnect-scheduled', ({ attempt, delay, error }) => {
      this.#options.logger.warn(
        { attempt, delayMs: delay, err: error },
        'RabbitMQ reconnect scheduled',
      );
    });
    connection.on('reconnect-failed', (error) => {
      this.#options.logger.error({ err: error }, 'RabbitMQ reconnect attempts exhausted');
    });
    connection.on('handler-error', (error, eventName) => {
      this.#options.logger.error(
        { err: error, eventName },
        'RabbitMQ connection event handler failed',
      );
    });
    this.#connection = connection;
  }

  public async close(): Promise<void> {
    const channel = this.#channel;
    const connection = this.#connection;
    this.#channel = undefined;
    this.#connection = undefined;
    this.#ready = false;

    if (channel !== undefined) {
      await channel.close();
    }

    if (connection !== undefined) {
      await connection.close();
    }
  }
}
