import { EventEmitter } from 'events';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { MercadoPagoGateway, createMercadoPagoClients } from '../infrastructure/mercadopago/MercadoPagoGateway';
import { verifyWebhookSignature } from '../infrastructure/mercadopago/webhookSignature';
import { DynamoPaymentRepository, DynamoQuoteRepository } from '../infrastructure/dynamodb/DynamoRepositories';
import { createDynamoClients, ensureTables, tableDefinitions } from '../infrastructure/dynamodb/client';
import { CommandConsumer, RETRY_HEADER, IncomingMessage, MessageAcks } from '../infrastructure/messaging/CommandConsumer';
import { RabbitMQClient } from '../infrastructure/messaging/RabbitMQClient';
import { assertBillingTopology, BILLING_COMMANDS_QUEUE } from '../infrastructure/messaging/topology';
import { setNewRelicForTesting, outgoingTraceHeaders, traceMessage, getNewRelic } from '../infrastructure/observability/tracing';
import { CommandDispatcher } from '../application/CommandDispatcher';
import { PermanentGatewayError } from '../application/ports';
import { Quote, QuoteStatus } from '../domain/Quote';
import { Payment, PaymentStatus } from '../domain/Payment';
import { loadConfig } from '../config';
import { gerarOrcamento, command, makeHarness } from './support/fakes';

const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
afterEach(() => setNewRelicForTesting(undefined));

const quote = new Quote({
  id: 'q-1', osId: 'os-1', sagaId: 's-1', clientId: 'c-1', clientEmail: 'c@t.com', vehicleId: 'v', totalCents: 25000,
  expiresAt: '2026-11-16T12:00:00.000Z', status: QuoteStatus.AGUARDANDO_APROVACAO,
  items: [
    { kind: 'SERVICE', refId: 's-1', description: 'Troca de óleo', quantity: 1, unitPriceCents: 15000 },
    { kind: 'PART', refId: 'p-1', description: 'Filtro', quantity: 2, unitPriceCents: 5000 },
  ],
});

describe('MercadoPagoGateway (Checkout Pro)', () => {
  function clients() {
    return {
      preference: { create: jest.fn().mockResolvedValue({ id: 'pref-1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' }) },
      payment: { get: jest.fn() },
      refund: { total: jest.fn() },
    };
  }

  it('cria a preferência com itens em reais, external_reference, webhook, retorno e expiração', async () => {
    const c = clients();
    const gw = new MercadoPagoGateway(c as never, { accessToken: 't', notificationUrl: 'https://gw/billing/webhooks/mercadopago', backUrl: 'https://oficina/pagamento' });
    const result = await gw.createCheckout({ paymentId: 'pay-1', quote, expiresAt: quote.expiresAt });

    expect(result).toEqual({ preferenceId: 'pref-1', checkoutUrl: expect.stringContaining('pref_id=pref-1') });
    const { body, requestOptions } = c.preference.create.mock.calls[0][0];
    expect(requestOptions).toEqual({ idempotencyKey: 'checkout-pay-1' });
    expect(body).toMatchObject({
      external_reference: 'pay-1',
      notification_url: 'https://gw/billing/webhooks/mercadopago',
      back_urls: { success: 'https://oficina/pagamento' },
      auto_return: 'approved',
      expires: true,
      expiration_date_to: quote.expiresAt,
      payer: { email: 'c@t.com' },
      metadata: { quote_id: 'q-1', os_id: 'os-1', saga_id: 's-1' },
    });
    expect(body.items).toEqual([
      expect.objectContaining({ id: 's-1', unit_price: 150, quantity: 1, currency_id: 'BRL', category_id: 'services' }),
      expect.objectContaining({ id: 'p-1', unit_price: 50, quantity: 2, category_id: 'others' }),
    ]);
  });

  it('omite webhook e retorno quando não configurados; falha sem init_point', async () => {
    const c = clients();
    const gw = new MercadoPagoGateway(c as never, { accessToken: 't' });
    await gw.createCheckout({ paymentId: 'p', quote, expiresAt: quote.expiresAt });
    const { body } = c.preference.create.mock.calls[0][0];
    expect(body.notification_url).toBeUndefined();
    expect(body.back_urls).toBeUndefined();

    c.preference.create.mockResolvedValueOnce({ id: 'x' });
    await expect(gw.createCheckout({ paymentId: 'p', quote, expiresAt: quote.expiresAt })).rejects.toThrow('não retornou');
  });

  it('consulta pagamento convertendo valores para centavos', async () => {
    const c = clients();
    c.payment.get.mockResolvedValueOnce({ id: 123, status: 'approved', status_detail: 'accredited', external_reference: 'pay-1', transaction_amount: 250.0 });
    c.payment.get.mockResolvedValueOnce({});
    const gw = new MercadoPagoGateway(c as never, { accessToken: 't' });
    expect(await gw.getPayment('123')).toEqual({ id: '123', status: 'approved', statusDetail: 'accredited', externalReference: 'pay-1', amountCents: 25000 });
    expect(await gw.getPayment('999')).toEqual({ id: '999', status: 'unknown', statusDetail: null, externalReference: null, amountCents: 0 });
  });

  it('estorno total com idempotência; 4xx vira erro definitivo, 5xx/429 transitório', async () => {
    const c = clients();
    const gw = new MercadoPagoGateway(c as never, { accessToken: 't' });
    c.refund.total.mockResolvedValueOnce({ id: 555, amount: 250 });
    expect(await gw.refund('123', 'refund-pay-1')).toEqual({ refundId: '555', amountCents: 25000 });
    expect(c.refund.total).toHaveBeenCalledWith({ payment_id: '123', requestOptions: { idempotencyKey: 'refund-pay-1' } });

    c.refund.total.mockRejectedValueOnce({ status: 400, message: 'Payment not refundable' });
    await expect(gw.refund('123', 'k')).rejects.toBeInstanceOf(PermanentGatewayError);
    c.refund.total.mockRejectedValueOnce({ cause: { status: 404 }, error: 'not_found' });
    await expect(gw.refund('123', 'k')).rejects.toThrow('not_found');
    c.refund.total.mockRejectedValueOnce({ statusCode: 429 });
    await expect(gw.refund('123', 'k')).rejects.not.toBeInstanceOf(PermanentGatewayError);
    c.refund.total.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(gw.refund('123', 'k')).rejects.toThrow('ECONNRESET');
  });

  it('cria os clientes reais do SDK', () => {
    const c = createMercadoPagoClients({ accessToken: 'TEST-123' });
    expect(c.preference.create).toBeInstanceOf(Function);
    expect(c.refund.total).toBeInstanceOf(Function);
  });

  it('verifyWebhookSignature trata erro não esperado do validador', () => {
    expect(verifyWebhookSignature({ xSignature: 'ts=1,v1=abc', xRequestId: 'r', dataId: '1' }, 's')).toMatchObject({ valid: false });
  });
});

describe('Repositórios DynamoDB', () => {
  const send = jest.fn();
  beforeEach(() => send.mockReset());
  const conditional = () => Object.assign(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));

  it('quotes: get, query por OS/saga, create e saveIfStatus condicionais', async () => {
    const repo = new DynamoQuoteRepository({ send } as never, 'billing-quotes');
    send.mockResolvedValueOnce({ Item: { ...quote } }).mockResolvedValueOnce({});
    expect(await repo.findById('q-1')).toBeInstanceOf(Quote);
    expect(await repo.findById('x')).toBeNull();

    send.mockResolvedValueOnce({ Items: [{ ...quote }] }).mockResolvedValueOnce({ Items: [{ ...quote }] }).mockResolvedValueOnce({});
    expect(await repo.findByOsId('os-1')).toHaveLength(1);
    expect((await repo.findBySagaId('s-1', 'os-1'))?.id).toBe('q-1');
    expect(await repo.findBySagaId('s-1', 'os-2')).toBeNull();
    expect(send.mock.calls[2][0].input).toMatchObject({ IndexName: 'osId-index', ExpressionAttributeValues: { ':osId': 'os-1' } });

    send.mockResolvedValueOnce({});
    expect(await repo.create(quote)).toBe(true);
    expect(send.mock.calls.at(-1)[0].input.ConditionExpression).toBe('attribute_not_exists(id)');

    send.mockRejectedValueOnce(conditional());
    expect(await repo.saveIfStatus(quote, [QuoteStatus.AGUARDANDO_APROVACAO, QuoteStatus.APROVADO])).toBe(false);
    expect(send.mock.calls.at(-1)[0].input).toMatchObject({
      ConditionExpression: '#status IN (:s0, :s1)',
      ExpressionAttributeValues: { ':s0': 'AGUARDANDO_APROVACAO', ':s1': 'APROVADO' },
    });

    send.mockRejectedValueOnce(new Error('throttling'));
    await expect(repo.create(quote)).rejects.toThrow('throttling');
  });

  it('payments: get, query por orçamento, create e saveIfStatus', async () => {
    const repo = new DynamoPaymentRepository({ send } as never, 'billing-payments');
    const p = new Payment({ id: 'pay-1', quoteId: 'q-1', status: PaymentStatus.PENDENTE });
    send.mockResolvedValueOnce({ Item: { ...p } }).mockResolvedValueOnce({});
    expect(await repo.findById('pay-1')).toBeInstanceOf(Payment);
    expect(await repo.findById('x')).toBeNull();
    send.mockResolvedValueOnce({ Items: [{ ...p }] }).mockResolvedValueOnce({ Items: [] });
    expect((await repo.findByQuoteId('q-1'))?.id).toBe('pay-1');
    expect(await repo.findByQuoteId('x')).toBeNull();
    send.mockResolvedValueOnce({}).mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' });
    expect(await repo.create(p)).toBe(true);
    expect(await repo.saveIfStatus(p, [PaymentStatus.PENDENTE])).toBe(false);
  });

  it('cria clientes (AWS e local) e tabelas com GSIs, ignorando as existentes', async () => {
    expect(createDynamoClients({ region: 'us-east-1' }).doc).toBeDefined();
    expect(createDynamoClients({ region: 'us-east-1', endpoint: 'http://localhost:8000' }).raw).toBeDefined();

    const defs = tableDefinitions('q', 'p');
    expect(defs[0].GlobalSecondaryIndexes[0].IndexName).toBe('osId-index');
    expect(defs[1].GlobalSecondaryIndexes[0].IndexName).toBe('quoteId-index');

    const raw = { send: jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce({ name: 'ResourceInUseException' }) };
    await ensureTables(raw as never, 'q', 'p');
    expect(raw.send).toHaveBeenCalledTimes(2);
    const failing = { send: jest.fn().mockRejectedValue(new Error('sem permissão')) };
    await expect(ensureTables(failing as never, 'q', 'p')).rejects.toThrow('sem permissão');
  });
});

describe('Mensageria', () => {
  const incoming = (content: string | object, headers: Record<string, unknown> = {}): IncomingMessage => ({
    content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    headers,
    routingKey: 'billing',
  });
  const acks = (): jest.Mocked<MessageAcks> => ({ ack: jest.fn(), deadLetter: jest.fn(), retry: jest.fn().mockResolvedValue(undefined) });

  it('consumidor: ack, DLQ para malformados, retry e DLQ após esgotar', async () => {
    const handler = { handle: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce('y') };
    const consumer = new CommandConsumer(handler, quiet);

    let a = acks();
    await consumer.onMessage(incoming(gerarOrcamento()), a);
    expect(a.ack).toHaveBeenCalled();

    a = acks();
    await consumer.onMessage(incoming('{x'), a);
    expect(a.deadLetter).toHaveBeenCalled();
    a = acks();
    await consumer.onMessage(incoming({ type: 'x' }), a);
    expect(a.deadLetter).toHaveBeenCalled();

    a = acks();
    await consumer.onMessage(incoming(gerarOrcamento(), { h: 1 }), a);
    expect(a.retry).toHaveBeenCalledWith({ h: 1, [RETRY_HEADER]: 1 });

    a = acks();
    await consumer.onMessage(incoming(gerarOrcamento(), { [RETRY_HEADER]: 2 }), a);
    expect(a.deadLetter).toHaveBeenCalled();
  });

  it('dispatcher encaminha cada comando ao caso de uso', async () => {
    const h = makeHarness();
    const logger = { info: jest.fn(), warn: jest.fn() };
    const d = new CommandDispatcher(h.billing, logger);
    await d.handle(gerarOrcamento());
    await d.handle(command('billing.CancelarOrcamento', {}));
    await d.handle(command('billing.EstornarPagamento', { paymentId: null }));
    await d.handle(command('billing.Outro', {}));
    expect(h.publisher.types()).toEqual(['billing.OrcamentoGerado', 'billing.OrcamentoCancelado', 'billing.PagamentoEstornado']);
    expect(logger.warn).toHaveBeenCalledWith('Comando desconhecido ignorado', expect.any(Object));
    expect(new CommandDispatcher(h.billing)).toBeDefined();
  });

  it('topologia: fila billing.commands ligada à exchange de comandos com DLX', async () => {
    const ch = { assertExchange: jest.fn(), assertQueue: jest.fn(), bindQueue: jest.fn() };
    await assertBillingTopology(ch);
    expect(ch.assertQueue).toHaveBeenCalledWith(BILLING_COMMANDS_QUEUE, { durable: true, arguments: { 'x-dead-letter-exchange': 'oficina.dlx' } });
    expect(ch.bindQueue).toHaveBeenCalledWith(BILLING_COMMANDS_QUEUE, 'oficina.commands', 'billing');
  });

  function fakeChannel() {
    return {
      assertExchange: jest.fn(), assertQueue: jest.fn(), bindQueue: jest.fn(), prefetch: jest.fn(), consume: jest.fn(),
      ack: jest.fn(), nack: jest.fn(), close: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn((_e, _r, _c, _o, cb: (err?: Error) => void) => cb()),
    };
  }
  function fakeConnection(channel: ReturnType<typeof fakeChannel>) {
    const conn = new EventEmitter() as EventEmitter & Record<string, jest.Mock>;
    conn.createConfirmChannel = jest.fn().mockResolvedValue(channel);
    conn.close = jest.fn().mockResolvedValue(undefined);
    return conn;
  }

  it('RabbitMQClient: reconecta, publica evento na exchange de eventos e consome', async () => {
    const channel = fakeChannel();
    const conn = fakeConnection(channel);
    const client = new RabbitMQClient('amqp://x', jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(conn) as never, quiet);
    expect(client.isConnected).toBe(false);
    await client.connect(3, 1);
    expect(client.isConnected).toBe(true);

    const evt = { ...gerarOrcamento(), type: 'billing.OrcamentoGerado' };
    await client.publish(evt);
    expect(channel.publish.mock.calls[0].slice(0, 2)).toEqual(['oficina.events', 'billing.OrcamentoGerado']);
    expect(channel.publish.mock.calls[0][3]).toMatchObject({ persistent: true, messageId: 'cmd-1' });

    const handler = jest.fn(async (_m: IncomingMessage, a: MessageAcks) => {
      a.ack();
      a.deadLetter();
      await a.retry({ [RETRY_HEADER]: 1 });
    });
    await client.consume(BILLING_COMMANDS_QUEUE, handler, 4);
    const onRaw = channel.consume.mock.calls[0][1];
    onRaw(null);
    const raw = { content: Buffer.from(JSON.stringify(evt)), properties: {}, fields: { routingKey: 'billing', exchange: 'oficina.commands' } };
    onRaw(raw);
    await new Promise((r) => setImmediate(r));
    expect(channel.prefetch).toHaveBeenCalledWith(4);
    expect(channel.ack).toHaveBeenCalledTimes(2);
    expect(channel.nack).toHaveBeenCalledWith(raw, false, false);

    conn.emit('error', new Error('x'));
    conn.emit('close');
    await client.close();
    expect(client.isConnected).toBe(false);
  });

  it('RabbitMQClient: erros de conexão, publicação e handler', async () => {
    await expect(new RabbitMQClient('amqp://x', jest.fn().mockRejectedValue(new Error('fora')) as never, quiet).connect(1, 1)).rejects.toThrow('fora');
    await expect(new RabbitMQClient('amqp://x', undefined, quiet).publish(gerarOrcamento())).rejects.toThrow('não conectado');
    await expect(new RabbitMQClient('amqp://x', undefined, quiet).close()).resolves.toBeUndefined();

    const channel = fakeChannel();
    channel.publish.mockImplementation((_e, _r, _c, _o, cb: (err?: Error) => void) => cb(new Error('nack')));
    const client = new RabbitMQClient('amqp://x', jest.fn().mockResolvedValue(fakeConnection(channel)) as never, quiet);
    await client.connect();
    await expect(client.publish(gerarOrcamento())).rejects.toThrow('nack');

    await client.consume('q', async () => {
      throw new Error('boom');
    });
    const raw = { content: Buffer.from('{}'), properties: { headers: {} }, fields: { routingKey: 'k', exchange: 'e' } };
    channel.consume.mock.calls[0][1](raw);
    await new Promise((r) => setImmediate(r));
    expect(channel.nack).toHaveBeenCalledWith(raw, false, false);
  });
});

describe('tracing', () => {
  it('sem licença executa direto; com agente propaga o trace', async () => {
    const saved = process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_LICENSE_KEY;
    setNewRelicForTesting(undefined);
    expect(getNewRelic()).toBeNull();
    expect(outgoingTraceHeaders()).toEqual({});
    expect(await traceMessage('x', {}, {}, async () => 1)).toBe(1);

    const tx = { insertDistributedTraceHeaders: jest.fn((h: Record<string, unknown>) => (h.traceparent = 't')), acceptDistributedTraceHeaders: jest.fn() };
    const api = {
      getTransaction: () => tx,
      startBackgroundTransaction: jest.fn((_n: string, _g: string, fn: () => unknown) => fn()) as unknown as <T>(n: string, g: string, fn: () => T) => T,
      addCustomAttributes: jest.fn(),
      noticeError: jest.fn(),
    };
    setNewRelicForTesting(api);
    expect(outgoingTraceHeaders()).toEqual({ traceparent: 't' });
    expect(await traceMessage('x', { traceparent: 'in' }, { a: 'b' }, async () => 2)).toBe(2);
    await expect(traceMessage('x', {}, {}, async () => Promise.reject(new Error('e')))).rejects.toThrow('e');
    expect(api.noticeError).toHaveBeenCalled();
    process.env.NEW_RELIC_LICENSE_KEY = saved;
  });

  it('com licença e sem agente instalado degrada para nulo', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'fake';
    jest.isolateModules(() => {
      jest.doMock('newrelic', () => {
        throw new Error('sem agente');
      });
      expect(jest.requireActual('../infrastructure/observability/tracing').getNewRelic()).toBeNull();
    });
    delete process.env.NEW_RELIC_LICENSE_KEY;
  });
});

describe('config', () => {
  it('valores padrão em desenvolvimento', () => {
    const c = loadConfig({ NODE_ENV: 'development' });
    expect(c).toMatchObject({
      port: 3000,
      isProduction: false,
      jwtSecret: 'dev-secret',
      quoteValidityHours: 72,
      dynamo: { region: 'us-east-1', quotesTable: 'billing-quotes', paymentsTable: 'billing-payments', autoCreateTables: false },
    });
    expect(c.rabbitUrl).toBeUndefined();
  });

  it('em produção exige segredos e lê todas as variáveis', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x' })).toThrow('MERCADO_PAGO_ACCESS_TOKEN');
    const c = loadConfig({
      NODE_ENV: 'production', PORT: '8080', JWT_SECRET: 'j', MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-1', MERCADO_PAGO_WEBHOOK_SECRET: 'w',
      MERCADO_PAGO_NOTIFICATION_URL: 'https://n', MERCADO_PAGO_BACK_URL: 'https://b', RABBITMQ_URL: 'amqp://r', ORIGIN_VERIFY_SECRET: 'o',
      QUOTE_VALIDITY_HOURS: '24', AWS_REGION: 'sa-east-1', DYNAMODB_ENDPOINT: 'http://d', QUOTES_TABLE: 'q', PAYMENTS_TABLE: 'p', DYNAMODB_AUTO_CREATE: 'true',
    });
    expect(c).toMatchObject({
      port: 8080, isProduction: true, rabbitUrl: 'amqp://r', originVerifySecret: 'o', quoteValidityHours: 24,
      dynamo: { region: 'sa-east-1', endpoint: 'http://d', quotesTable: 'q', paymentsTable: 'p', autoCreateTables: true },
      mercadoPago: { accessToken: 'APP_USR-1', webhookSecret: 'w', notificationUrl: 'https://n', backUrl: 'https://b' },
    });
  });
});
