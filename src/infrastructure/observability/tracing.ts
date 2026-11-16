/**
 * Integração opcional com o New Relic para distributed tracing através do RabbitMQ.
 * O agente só é carregado quando há licença configurada (em testes e dev local fica inativo).
 */

interface NewRelicTransactionHandle {
  insertDistributedTraceHeaders(headers: Record<string, unknown>): void;
  acceptDistributedTraceHeaders(transportType: string, headers: Record<string, unknown>): void;
}

interface NewRelicApi {
  getTransaction(): NewRelicTransactionHandle;
  startBackgroundTransaction<T>(name: string, group: string, handle: () => T): T;
  addCustomAttributes(attrs: Record<string, string | number | boolean>): void;
  noticeError(error: Error): void;
}

let cached: NewRelicApi | null | undefined;

export function getNewRelic(): NewRelicApi | null {
  if (cached !== undefined) return cached;
  if (!process.env.NEW_RELIC_LICENSE_KEY) {
    cached = null;
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('newrelic') as NewRelicApi;
  } catch {
    cached = null;
  }
  return cached;
}

/** Para testes: força um agente (ou nenhum). */
export function setNewRelicForTesting(api: NewRelicApi | null | undefined): void {
  cached = api;
}

/** Headers W3C/New Relic do trace atual, para propagar na mensagem publicada. */
export function outgoingTraceHeaders(): Record<string, string> {
  const nr = getNewRelic();
  if (!nr) return {};
  const headers: Record<string, string> = {};
  nr.getTransaction().insertDistributedTraceHeaders(headers);
  return headers;
}

/**
 * Executa o processamento de uma mensagem como transação de background no New Relic,
 * continuando o trace recebido nos headers (um único trace gateway → serviços → broker).
 */
export async function traceMessage<T>(
  name: string,
  headers: Record<string, unknown>,
  attributes: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  const nr = getNewRelic();
  if (!nr) return work();
  return nr.startBackgroundTransaction(name, 'RabbitMQ', async () => {
    nr.getTransaction().acceptDistributedTraceHeaders('AMQP', headers);
    nr.addCustomAttributes(attributes);
    try {
      return await work();
    } catch (err) {
      nr.noticeError(err as Error);
      throw err;
    }
  });
}
