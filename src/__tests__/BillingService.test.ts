import { Events } from '../domain/messages';
import { Quote, QuoteStatus } from '../domain/Quote';
import { PaymentStatus } from '../domain/Payment';
import { PermanentGatewayError } from '../application/ports';
import { command, gerarOrcamento, makeHarness, T0 } from './support/fakes';

const client = { sub: 'client-1', type: 'client' as const };
const otherClient = { sub: 'client-2', type: 'client' as const };
const staff = { sub: 'admin', type: 'staff' as const };

async function approvedPayment() {
  const h = makeHarness();
  const quote = await h.billing.generateQuote(gerarOrcamento());
  const { payment } = await h.billing.approveQuote(quote.id, client);
  h.gateway.pay('mp-1', payment.id);
  await h.billing.processPaymentNotification('mp-1');
  return { ...h, quote, paymentId: payment.id };
}

describe('Quote (domínio)', () => {
  it('calcula total em centavos e prazo de validade', () => {
    const q = Quote.create({
      id: 'q', osId: 'o', sagaId: 's', clientId: 'c', clientEmail: 'e', vehicleId: 'v', now: T0, validityHours: 24,
      items: [{ kind: 'PART', refId: 'p', description: 'x', quantity: 3, unitPriceCents: 1999 }],
    });
    expect(q.totalCents).toBe(5997);
    expect(q.expiresAt).toBe('2026-11-14T12:00:00.000Z');
    expect(q.isExpired(new Date('2026-11-14T12:00:00Z'))).toBe(true);
  });

  it.each([
    [[], 'Orçamento sem itens'],
    [[{ kind: 'PART', refId: 'p', description: 'x', quantity: 1, unitPriceCents: 10.5 }], 'Preço inválido no item p'],
    [[{ kind: 'PART', refId: 'p', description: 'x', quantity: 0, unitPriceCents: 10 }], 'Quantidade inválida no item p'],
  ])('rejeita itens inválidos (%p)', (items, message) => {
    expect(() =>
      Quote.create({ id: 'q', osId: 'o', sagaId: 's', clientId: 'c', clientEmail: 'e', vehicleId: 'v', now: T0, validityHours: 1, items: items as never }),
    ).toThrow(message);
  });
});

describe('generateQuote (billing.GerarOrcamento)', () => {
  it('cria o orçamento e publica OrcamentoGerado com causationId do comando', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());

    expect(quote).toMatchObject({ osId: 'os-1', sagaId: 'saga-1', totalCents: 25000, status: QuoteStatus.AGUARDANDO_APROVACAO });
    expect(h.publisher.last()).toMatchObject({
      type: Events.ORCAMENTO_GERADO,
      sagaId: 'saga-1',
      osId: 'os-1',
      causationId: 'cmd-1',
      producer: 'billing-service',
      payload: { quoteId: quote.id, totalCents: 25000, expiresAt: '2026-11-16T12:00:00.000Z' },
    });
  });

  it('é idempotente: comando reentregue não cria segundo orçamento e repete o mesmo messageId', async () => {
    const h = makeHarness();
    const first = await h.billing.generateQuote(gerarOrcamento());
    const second = await h.billing.generateQuote(gerarOrcamento());
    expect(second.id).toBe(first.id);
    expect(h.quotes.items.size).toBe(1);
    expect(h.publisher.events[0].messageId).toBe(h.publisher.events[1].messageId);
  });

  it('se a publicação falhar, a reentrega publica o evento sem duplicar o orçamento', async () => {
    const h = makeHarness();
    h.publisher.failNext = 1;
    await expect(h.billing.generateQuote(gerarOrcamento())).rejects.toThrow('broker indisponível');
    await h.billing.generateQuote(gerarOrcamento());
    expect(h.quotes.items.size).toBe(1);
    expect(h.publisher.types()).toEqual([Events.ORCAMENTO_GERADO]);
  });

  it('usa o orçamento gravado por outra réplica em caso de corrida na criação', async () => {
    const h = makeHarness();
    const original = h.quotes.create.bind(h.quotes);
    jest.spyOn(h.quotes, 'create').mockImplementationOnce(async (q) => {
      await original(new Quote({ ...q, id: 'outra-replica' }));
      return false;
    });
    const quote = await h.billing.generateQuote(gerarOrcamento());
    expect(quote.id).toBe('outra-replica');
  });

  it('aceita payload sem items como inválido', async () => {
    const h = makeHarness();
    await expect(h.billing.generateQuote(gerarOrcamento({ payload: { clientId: 'c', clientEmail: 'e', vehicleId: 'v' } as never }))).rejects.toThrow(
      'Orçamento sem itens',
    );
  });
});

describe('approveQuote / rejectQuote (cliente)', () => {
  it('aprova: cria checkout Checkout Pro, grava pagamento PENDENTE e publica OrcamentoAprovado', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);

    expect(h.gateway.checkouts[0]).toMatchObject({ paymentId: payment.id, expiresAt: quote.expiresAt });
    expect(payment).toMatchObject({ status: PaymentStatus.PENDENTE, amountCents: 25000, checkoutUrl: `https://mp.test/checkout/${payment.id}` });
    expect((await h.quotes.findById(quote.id))?.status).toBe(QuoteStatus.APROVADO);
    expect(h.publisher.last()).toMatchObject({
      type: Events.ORCAMENTO_APROVADO,
      payload: { quoteId: quote.id, paymentId: payment.id, checkoutUrl: payment.checkoutUrl },
    });
  });

  it('aprovação repetida devolve o mesmo checkout sem criar outro', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const a = await h.billing.approveQuote(quote.id, client);
    const b = await h.billing.approveQuote(quote.id, client);
    expect(b.payment.id).toBe(a.payment.id);
    expect(h.gateway.checkouts).toHaveLength(1);
  });

  it('funcionário pode aprovar; outro cliente não', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    await expect(h.billing.approveQuote(quote.id, otherClient)).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.billing.approveQuote(quote.id, staff)).resolves.toBeDefined();
  });

  it('não aprova orçamento expirado, inexistente ou já recusado', async () => {
    let now = T0;
    const h = makeHarness(() => now);
    const quote = await h.billing.generateQuote(gerarOrcamento());
    await expect(h.billing.approveQuote('x', client)).rejects.toMatchObject({ statusCode: 404 });
    now = new Date('2026-11-20T00:00:00Z');
    await expect(h.billing.approveQuote(quote.id, client)).rejects.toMatchObject({ statusCode: 422 });

    now = T0;
    await h.billing.rejectQuote(quote.id, client, 'caro');
    await expect(h.billing.approveQuote(quote.id, client)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('falha do Mercado Pago ao criar o checkout vira 502 sem alterar o orçamento', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    jest.spyOn(h.gateway, 'createCheckout').mockRejectedValueOnce({ status: 401, message: 'Must provide your access_token' });
    await expect(h.billing.approveQuote(quote.id, client)).rejects.toMatchObject({ statusCode: 502 });
    expect((await h.quotes.findById(quote.id))?.status).toBe(QuoteStatus.AGUARDANDO_APROVACAO);
    expect(h.payments.items.size).toBe(0);
    expect(h.logger.warn).toHaveBeenCalledWith('Falha ao criar checkout no Mercado Pago', expect.objectContaining({ status: 401 }));
  });

  it('retorna 409 se outra operação alterou o orçamento no meio da aprovação', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    jest.spyOn(h.quotes, 'saveIfStatus').mockResolvedValueOnce(false);
    await expect(h.billing.approveQuote(quote.id, client)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('recusa publica OrcamentoRecusado (idempotente) com motivo', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const rejected = await h.billing.rejectQuote(quote.id, client, 'Valor alto');
    await h.billing.rejectQuote(quote.id, client);
    expect(rejected.status).toBe(QuoteStatus.RECUSADO);
    expect(h.publisher.events.filter((e) => e.type === Events.ORCAMENTO_RECUSADO)).toHaveLength(2);
    expect(h.publisher.last().payload).toEqual({ quoteId: quote.id, reason: 'Valor alto' });
  });

  it('recusa sem motivo usa texto padrão e trata erros', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    await expect(h.billing.rejectQuote('x', client)).rejects.toMatchObject({ statusCode: 404 });
    jest.spyOn(h.quotes, 'saveIfStatus').mockResolvedValueOnce(false);
    await expect(h.billing.rejectQuote(quote.id, client)).rejects.toMatchObject({ statusCode: 409 });
    const r = await h.billing.rejectQuote(quote.id, client, '');
    expect(r.decisionReason).toBe('Recusado pelo cliente');
  });

  it('consulta e lista respeitando o dono do orçamento', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    expect((await h.billing.getQuote(quote.id, client)).payment).toBeNull();
    await expect(h.billing.getQuote(quote.id, otherClient)).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.billing.getQuote('x', staff)).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.billing.listByServiceOrder('os-1', client)).toHaveLength(1);
    expect(await h.billing.listByServiceOrder('os-1', otherClient)).toHaveLength(0);
    expect(await h.billing.listByServiceOrder('os-1', staff)).toHaveLength(1);
  });
});

describe('processPaymentNotification (webhook)', () => {
  it('pagamento aprovado confirma e publica PagamentoConfirmado; webhook repetido republica o mesmo evento', async () => {
    const h = await approvedPayment();
    const p = await h.payments.findById(h.paymentId);
    expect(p).toMatchObject({ status: PaymentStatus.APROVADO, mpPaymentId: 'mp-1', paidAt: T0.toISOString() });
    const confirmed = h.publisher.events.filter((e) => e.type === Events.PAGAMENTO_CONFIRMADO);
    expect(confirmed[0].payload).toMatchObject({ paymentId: h.paymentId, mpPaymentId: 'mp-1', amountCents: 25000 });

    await h.billing.processPaymentNotification('mp-1');
    const again = h.publisher.events.filter((e) => e.type === Events.PAGAMENTO_CONFIRMADO);
    expect(again).toHaveLength(2);
    expect(again[1].messageId).toBe(again[0].messageId);
  });

  it.each(['rejected', 'cancelled'])('status %s recusa e publica PagamentoRecusado', async (status) => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);
    h.gateway.pay('mp-9', payment.id, status, 25000, 'cc_rejected_insufficient_amount');
    expect(await h.billing.processPaymentNotification('mp-9')).toEqual({ handled: true, status: PaymentStatus.RECUSADO });
    expect(h.publisher.last()).toMatchObject({
      type: Events.PAGAMENTO_RECUSADO,
      payload: { mpStatus: status, mpStatusDetail: 'cc_rejected_insufficient_amount' },
    });
  });

  it('nova tentativa aprovada após recusa confirma o pagamento', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);
    h.gateway.pay('mp-r', payment.id, 'rejected');
    await h.billing.processPaymentNotification('mp-r');
    h.gateway.pay('mp-a', payment.id, 'approved');
    expect((await h.billing.processPaymentNotification('mp-a')).status).toBe(PaymentStatus.APROVADO);
  });

  it('ignora status pendente, pagamento desconhecido e sem external_reference', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);
    h.gateway.pay('mp-p', payment.id, 'in_process');
    expect(await h.billing.processPaymentNotification('mp-p')).toEqual({ handled: false, status: 'in_process' });

    h.gateway.pay('mp-x', 'nao-existe');
    expect((await h.billing.processPaymentNotification('mp-x')).handled).toBe(false);

    h.gateway.payments.set('mp-n', { id: 'mp-n', status: 'approved', statusDetail: null, externalReference: null, amountCents: 1 });
    expect((await h.billing.processPaymentNotification('mp-n')).handled).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('recusa chegando depois da aprovação não desfaz o pagamento', async () => {
    const h = await approvedPayment();
    h.gateway.pay('mp-late', h.paymentId, 'rejected');
    const r = await h.billing.processPaymentNotification('mp-late');
    expect(r).toEqual({ handled: true, status: PaymentStatus.APROVADO });
    expect(h.publisher.types()).not.toContain(Events.PAGAMENTO_RECUSADO);
  });
});

describe('refundPayment (billing.EstornarPagamento — compensação)', () => {
  it('estorna no Mercado Pago com chave de idempotência e publica PagamentoEstornado', async () => {
    const h = await approvedPayment();
    await h.billing.refundPayment(command('billing.EstornarPagamento', { paymentId: h.paymentId, reason: 'sem estoque' }));
    expect(h.gateway.refunds).toEqual([{ id: 'mp-1', key: `refund-${h.paymentId}` }]);
    expect((await h.payments.findById(h.paymentId))?.status).toBe(PaymentStatus.ESTORNADO);
    expect(h.publisher.last()).toMatchObject({
      type: Events.PAGAMENTO_ESTORNADO,
      causationId: 'cmd-billing.EstornarPagamento',
      payload: { paymentId: h.paymentId, mpRefundId: 'ref-mp-1', amountCents: 25000 },
    });
  });

  it('comando repetido não estorna duas vezes', async () => {
    const h = await approvedPayment();
    const cmd = command('billing.EstornarPagamento', { paymentId: h.paymentId });
    await h.billing.refundPayment(cmd);
    await h.billing.refundPayment(cmd);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(h.publisher.events.filter((e) => e.type === Events.PAGAMENTO_ESTORNADO)).toHaveLength(2);
  });

  it('sem cobrança (pagamento inexistente, nulo ou pendente) conclui com valor zero', async () => {
    const h = makeHarness();
    await h.billing.refundPayment(command('billing.EstornarPagamento', { paymentId: null }));
    expect(h.publisher.last().payload).toEqual({ paymentId: null, mpRefundId: null, amountCents: 0 });

    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);
    await h.billing.refundPayment(command('billing.EstornarPagamento', { paymentId: payment.id }));
    expect(h.publisher.last().payload).toEqual({ paymentId: payment.id, mpRefundId: null, amountCents: 0 });
    expect(h.gateway.refunds).toHaveLength(0);
  });

  it('erro definitivo do gateway publica EstornoFalhou', async () => {
    const h = await approvedPayment();
    h.gateway.refundError = new PermanentGatewayError('pagamento não reembolsável');
    await h.billing.refundPayment(command('billing.EstornarPagamento', { paymentId: h.paymentId }));
    expect(h.publisher.last()).toMatchObject({ type: Events.ESTORNO_FALHOU, payload: { error: 'pagamento não reembolsável' } });
  });

  it('erro transitório propaga para nova tentativa do consumidor', async () => {
    const h = await approvedPayment();
    h.gateway.refundError = new Error('timeout');
    await expect(h.billing.refundPayment(command('billing.EstornarPagamento', { paymentId: h.paymentId }))).rejects.toThrow('timeout');
    expect((await h.payments.findById(h.paymentId))?.status).toBe(PaymentStatus.APROVADO);
  });
});

describe('cancelQuote (billing.CancelarOrcamento — compensação)', () => {
  it('cancela orçamento aprovado e o checkout pendente', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    const { payment } = await h.billing.approveQuote(quote.id, client);
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', { quoteId: quote.id, reason: 'expirou' }));

    expect(await h.quotes.findById(quote.id)).toMatchObject({ status: QuoteStatus.CANCELADO, decisionReason: 'expirou' });
    expect((await h.payments.findById(payment.id))?.status).toBe(PaymentStatus.CANCELADO);
    expect(h.publisher.last()).toMatchObject({ type: Events.ORCAMENTO_CANCELADO, payload: { quoteId: quote.id } });
  });

  it('localiza pela saga quando quoteId não vem, e é idempotente', async () => {
    const h = makeHarness();
    const quote = await h.billing.generateQuote(gerarOrcamento());
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', {}));
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', {}));
    expect((await h.quotes.findById(quote.id))?.decisionReason).toBe('Cancelado pela saga');
    expect(h.publisher.events.filter((e) => e.type === Events.ORCAMENTO_CANCELADO)).toHaveLength(2);
  });

  it('confirma o cancelamento mesmo sem orçamento encontrado', async () => {
    const h = makeHarness();
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', { quoteId: 'nao-existe' }));
    expect(h.publisher.last().payload).toEqual({ quoteId: 'nao-existe' });
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', { quoteId: null }));
    expect(h.publisher.last().payload).toEqual({ quoteId: null });
  });

  it('não mexe em pagamento já aprovado ao cancelar (o estorno é outro passo)', async () => {
    const h = await approvedPayment();
    await h.billing.cancelQuote(command('billing.CancelarOrcamento', { quoteId: h.quote.id }));
    expect((await h.payments.findById(h.paymentId))?.status).toBe(PaymentStatus.APROVADO);
  });
});
