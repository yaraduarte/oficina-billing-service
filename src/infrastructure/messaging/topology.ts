import { BILLING_ROUTING_KEY, Exchanges } from '../../domain/messages';

export const BILLING_COMMANDS_QUEUE = 'billing.commands';
export const BILLING_COMMANDS_DLQ = 'billing.commands.dlq';
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface TopologyChannel {
  assertExchange(name: string, type: string, options?: object): Promise<unknown>;
  assertQueue(name: string, options?: object): Promise<unknown>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
}

/**
 * Topologia do billing (docs/fase4/EVENTOS.md): consome a fila billing.commands
 * (exchange de comandos, routing key "billing") e publica na exchange de eventos.
 */
export async function assertBillingTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(Exchanges.COMMANDS, 'direct', { durable: true });
  await channel.assertExchange(Exchanges.EVENTS, 'topic', { durable: true });
  await channel.assertExchange(Exchanges.DLX, 'fanout', { durable: true });

  await channel.assertQueue(BILLING_COMMANDS_DLQ, { durable: true });
  await channel.bindQueue(BILLING_COMMANDS_DLQ, Exchanges.DLX, '');

  await channel.assertQueue(BILLING_COMMANDS_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': Exchanges.DLX },
  });
  await channel.bindQueue(BILLING_COMMANDS_QUEUE, Exchanges.COMMANDS, BILLING_ROUTING_KEY);
}
