import { Events } from '../domain/messages';
import { Payment, PaymentStatus } from '../domain/Payment';
import { DynamoPaymentRepository } from '../infrastructure/dynamodb/DynamoRepositories';
import { MercadoPagoGateway } from '../infrastructure/mercadopago/MercadoPagoGateway';
import { PeriodicJob } from '../infrastructure/scheduling/PeriodicJob';
import { loadConfig } from '../config';
import { gerarOrcamento, makeHarness } from './support/fakes';

const client = { sub: 'client-1', type: 'client' as const };

async function pendingPayment() {
  const h = makeHarness();
  const quote = await h.billing.generateQuote(gerarOrcamento());
  const { payment } = await h.billing.approveQuote(quote.id, client);
  return { ...h, paymentId: payment.id };
}

describe('Reconciliação de pagamentos com o Mercado Pago', () => {
  it('confirma o pagamento aprovado no MP mesmo sem webhook e publica PagamentoConfirmado', async () => {
    const h = await pendingPayment();
    h.gateway.pay('mp-old', h.paymentId, 'rejected', 20000, 'cc_rejected_other_reason');
    h.gateway.pay('mp-ok', h.paymentId, 'approved');

    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 1, updated: 1 });
    expect((await h.payments.findById(h.paymentId))?.status).toBe(PaymentStatus.APROVADO);
    expect(h.publisher.last()).toMatchObject({ type: Events.PAGAMENTO_CONFIRMADO, payload: { mpPaymentId: 'mp-ok' } });

    // já aprovado: deixa de ser pendente e não é reprocessado
    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 0, updated: 0 });
  });

  it('recusa quando o MP só tem pagamento rejeitado; ignora pendentes no MP', async () => {
    const h = await pendingPayment();
    h.gateway.pay('mp-pend', h.paymentId, 'in_process', 20000, 'pending_review');
    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 1, updated: 0 });

    h.gateway.pay('mp-rej', h.paymentId, 'rejected', 20000, 'cc_rejected_insufficient_amount');
    expect(await h.billing.reconcilePendingPayments(10)).toEqual({ checked: 1, updated: 1 });
    expect(h.publisher.last()).toMatchObject({ type: Events.PAGAMENTO_RECUSADO });
  });

  it('nada no MP: continua pendente; erro na consulta é registrado sem interromper', async () => {
    const h = await pendingPayment();
    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 1, updated: 0 });
    h.gateway.searchError = new Error('MP fora');
    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 1, updated: 0 });
    expect(h.logger.warn).toHaveBeenCalledWith('Falha ao reconciliar pagamento', expect.objectContaining({ error: 'MP fora' }));
    h.gateway.searchError = 'texto' as never;
    await h.billing.reconcilePendingPayments();
    expect(h.logger.warn).toHaveBeenLastCalledWith('Falha ao reconciliar pagamento', expect.objectContaining({ error: 'texto' }));
  });

  it('pagamento do MP que não pôde ser aplicado não conta como atualizado', async () => {
    const h = await pendingPayment();
    h.gateway.pay('mp-x', h.paymentId, 'approved');
    jest.spyOn(h.billing, 'processPaymentNotification').mockResolvedValueOnce({ handled: false });
    expect(await h.billing.reconcilePendingPayments()).toEqual({ checked: 1, updated: 0 });
  });
});

describe('DynamoPaymentRepository.findPending', () => {
  it('pagina o scan filtrando PENDENTE e respeita o limite', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ Items: [{ id: 'a', status: 'PENDENTE' }], LastEvaluatedKey: { id: 'a' } })
      .mockResolvedValueOnce({ Items: [{ id: 'b', status: 'PENDENTE' }, { id: 'c', status: 'PENDENTE' }] });
    const repo = new DynamoPaymentRepository({ send } as never, 'billing-payments');
    const found = await repo.findPending(2);
    expect(found.map((p) => p.id)).toEqual(['a', 'b']);
    expect(found[0]).toBeInstanceOf(Payment);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: 'billing-payments',
      FilterExpression: '#s = :pending',
      ExpressionAttributeValues: { ':pending': 'PENDENTE' },
    });
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'a' });

    send.mockReset().mockResolvedValueOnce({});
    expect(await repo.findPending(5)).toEqual([]);
  });
});

describe('MercadoPagoGateway.findPaymentsByReference', () => {
  it('busca por external_reference, mais recentes primeiro, convertendo para centavos', async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce({
        results: [{ id: 123, status: 'approved', status_detail: 'accredited', external_reference: 'pay-1', transaction_amount: 200 }, {}],
      })
      .mockResolvedValueOnce({});
    const gw = new MercadoPagoGateway({ preference: {}, payment: { get: jest.fn(), search }, refund: {} } as never, { accessToken: 't' });
    expect(await gw.findPaymentsByReference('pay-1')).toEqual([
      { id: '123', status: 'approved', statusDetail: 'accredited', externalReference: 'pay-1', amountCents: 20000 },
      { id: '', status: 'unknown', statusDetail: null, externalReference: null, amountCents: 0 },
    ]);
    expect(search).toHaveBeenCalledWith({ options: { external_reference: 'pay-1', sort: 'date_created', criteria: 'desc' } });
    expect(await gw.findPaymentsByReference('pay-2')).toEqual([]);
  });
});

describe('PeriodicJob', () => {
  it('executa sem sobrepor, registra falhas, para e não inicia com intervalo 0', async () => {
    let release!: () => void;
    const task = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockRejectedValueOnce(new Error('falhou'))
      .mockRejectedValueOnce('texto')
      .mockResolvedValue(undefined);
    const logger = { warn: jest.fn() };
    const job = new PeriodicJob('Teste', task, 5, logger);
    const first = job.tick();
    await job.tick(); // em andamento: ignorado
    release();
    await first;
    await job.tick();
    await job.tick();
    expect(logger.warn).toHaveBeenNthCalledWith(1, '[Teste] Falha na execução', { error: 'falhou' });
    expect(logger.warn).toHaveBeenNthCalledWith(2, '[Teste] Falha na execução', { error: 'texto' });

    const before = task.mock.calls.length;
    job.start();
    job.start();
    await new Promise((r) => setTimeout(r, 60));
    job.stop();
    job.stop();
    expect(task.mock.calls.length).toBeGreaterThan(before);

    const off = jest.fn();
    const disabled = new PeriodicJob('Off', off, 0);
    disabled.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(off).not.toHaveBeenCalled();
    expect(new PeriodicJob('Default', off, 10)).toBeDefined();
  });
});

describe('config da reconciliação', () => {
  it('padrão de 30s e configurável por variável', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).paymentReconcileIntervalMs).toBe(30000);
    expect(loadConfig({ NODE_ENV: 'development', PAYMENT_RECONCILE_INTERVAL_MS: '0' }).paymentReconcileIntervalMs).toBe(0);
  });
});
