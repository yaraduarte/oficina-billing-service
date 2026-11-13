import { Config } from './config';
import { BillingService } from './application/BillingService';
import { CommandDispatcher } from './application/CommandDispatcher';
import { IEventPublisher, Logger } from './application/ports';
import { createDynamoClients, ensureTables } from './infrastructure/dynamodb/client';
import { DynamoPaymentRepository, DynamoQuoteRepository } from './infrastructure/dynamodb/DynamoRepositories';
import { createMercadoPagoClients, MercadoPagoGateway } from './infrastructure/mercadopago/MercadoPagoGateway';
import { RabbitMQClient } from './infrastructure/messaging/RabbitMQClient';
import { CommandConsumer } from './infrastructure/messaging/CommandConsumer';
import { BILLING_COMMANDS_QUEUE } from './infrastructure/messaging/topology';
import { createApp } from './infrastructure/web/app';

const logger: Logger = {
  info: (msg, meta) => console.log(`[Billing] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[Billing] ${msg}`, meta ? JSON.stringify(meta) : ''),
};

/** Publicador que falha de forma explícita quando o broker não está configurado. */
const noBrokerPublisher: IEventPublisher = {
  publish: async (e) => {
    throw new Error(`RABBITMQ_URL não configurada: evento ${e.type} não pode ser publicado`);
  },
};

export interface BillingRuntime {
  app: ReturnType<typeof createApp>;
  stop(): Promise<void>;
}

/** Composição do serviço: DynamoDB, Mercado Pago, RabbitMQ e HTTP. */
export async function bootstrap(config: Config, deps: { rabbit?: RabbitMQClient } = {}): Promise<BillingRuntime> {
  const dynamo = createDynamoClients(config.dynamo);
  if (config.dynamo.autoCreateTables) {
    await ensureTables(dynamo.raw, config.dynamo.quotesTable, config.dynamo.paymentsTable);
    logger.info('Tabelas DynamoDB verificadas', { quotes: config.dynamo.quotesTable, payments: config.dynamo.paymentsTable });
  }

  const rabbit = deps.rabbit ?? (config.rabbitUrl ? new RabbitMQClient(config.rabbitUrl) : undefined);
  if (rabbit) await rabbit.connect();
  else logger.warn('RABBITMQ_URL não definida: comandos da Saga não serão consumidos');

  const billing = new BillingService(
    new DynamoQuoteRepository(dynamo.doc, config.dynamo.quotesTable),
    new DynamoPaymentRepository(dynamo.doc, config.dynamo.paymentsTable),
    new MercadoPagoGateway(createMercadoPagoClients(config.mercadoPago), config.mercadoPago),
    rabbit ?? noBrokerPublisher,
    { quoteValidityHours: config.quoteValidityHours, logger },
  );

  if (rabbit) {
    const consumer = new CommandConsumer(new CommandDispatcher(billing, logger));
    await rabbit.consume(BILLING_COMMANDS_QUEUE, (msg, acks) => consumer.onMessage(msg, acks));
    logger.info(`Consumindo ${BILLING_COMMANDS_QUEUE}`);
  }

  const app = createApp({
    billing,
    jwtSecret: config.jwtSecret,
    originVerifySecret: config.originVerifySecret,
    webhookSecret: config.mercadoPago.webhookSecret,
    allowUnsignedWebhooks: !config.isProduction,
    isReady: () => (rabbit ? rabbit.isConnected : true),
  });

  return {
    app,
    stop: async () => {
      await rabbit?.close();
    },
  };
}
