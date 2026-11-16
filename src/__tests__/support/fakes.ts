import { Quote, QuoteStatus } from '../../domain/Quote';
import { Payment, PaymentStatus } from '../../domain/Payment';
import { MessageEnvelope } from '../../domain/messages';
import {
  CheckoutRequest,
  GatewayPayment,
  IEventPublisher,
  IPaymentGateway,
  IPaymentRepository,
  IQuoteRepository,
} from '../../application/ports';
import { BillingService } from '../../application/BillingService';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class InMemoryQuoteRepository implements IQuoteRepository {
  items = new Map<string, Quote>();
  async findById(id: string) {
    const q = this.items.get(id);
    return q ? new Quote(clone(q)) : null;
  }
  async findBySagaId(sagaId: string, osId: string) {
    const q = [...this.items.values()].find((x) => x.sagaId === sagaId && x.osId === osId);
    return q ? new Quote(clone(q)) : null;
  }
  async findByOsId(osId: string) {
    return [...this.items.values()].filter((q) => q.osId === osId).map((q) => new Quote(clone(q)));
  }
  async create(quote: Quote) {
    if (this.items.has(quote.id)) return false;
    this.items.set(quote.id, new Quote(clone(quote)));
    return true;
  }
  async saveIfStatus(quote: Quote, expected: QuoteStatus[]) {
    const current = this.items.get(quote.id);
    if (!current || !expected.includes(current.status)) return false;
    this.items.set(quote.id, new Quote(clone(quote)));
    return true;
  }
}

export class InMemoryPaymentRepository implements IPaymentRepository {
  items = new Map<string, Payment>();
  async findById(id: string) {
    const p = this.items.get(id);
    return p ? new Payment(clone(p)) : null;
  }
  async findByQuoteId(quoteId: string) {
    const p = [...this.items.values()].find((x) => x.quoteId === quoteId);
    return p ? new Payment(clone(p)) : null;
  }
  async create(payment: Payment) {
    if (this.items.has(payment.id)) return false;
    this.items.set(payment.id, new Payment(clone(payment)));
    return true;
  }
  async saveIfStatus(payment: Payment, expected: PaymentStatus[]) {
    const current = this.items.get(payment.id);
    if (!current || !expected.includes(current.status)) return false;
    this.items.set(payment.id, new Payment(clone(payment)));
    return true;
  }
}

/** Mercado Pago simulado: guarda checkouts e permite definir o status de cada pagamento. */
export class FakeGateway implements IPaymentGateway {
  checkouts: CheckoutRequest[] = [];
  payments = new Map<string, GatewayPayment>();
  refunds: { id: string; key: string }[] = [];
  refundError: Error | null = null;

  async createCheckout(request: CheckoutRequest) {
    this.checkouts.push(request);
    return { preferenceId: `pref-${request.paymentId}`, checkoutUrl: `https://mp.test/checkout/${request.paymentId}` };
  }
  async getPayment(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new Error(`pagamento ${id} não existe no MP`);
    return p;
  }
  async refund(id: string, key: string) {
    if (this.refundError) throw this.refundError;
    this.refunds.push({ id, key });
    return { refundId: `ref-${id}`, amountCents: this.payments.get(id)?.amountCents ?? 0 };
  }
  /** Simula o cliente pagando no checkout. */
  pay(mpId: string, paymentId: string, status = 'approved', amountCents = 25000, statusDetail = 'accredited') {
    this.payments.set(mpId, { id: mpId, status, statusDetail, externalReference: paymentId, amountCents });
  }
}

export class RecordingPublisher implements IEventPublisher {
  events: MessageEnvelope[] = [];
  failNext = 0;
  async publish(envelope: MessageEnvelope) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('broker indisponível');
    }
    this.events.push(envelope);
  }
  types() {
    return this.events.map((e) => e.type);
  }
  last() {
    return this.events[this.events.length - 1];
  }
}

export const T0 = new Date('2026-11-13T12:00:00Z');

export function makeHarness(now: () => Date = () => T0) {
  const quotes = new InMemoryQuoteRepository();
  const payments = new InMemoryPaymentRepository();
  const gateway = new FakeGateway();
  const publisher = new RecordingPublisher();
  let seq = 0;
  const logger = { info: jest.fn(), warn: jest.fn() };
  const billing = new BillingService(quotes, payments, gateway, publisher, {
    quoteValidityHours: 72,
    idGenerator: () => `id-${++seq}`,
    clock: now,
    logger,
  });
  return { quotes, payments, gateway, publisher, billing, logger };
}

export function gerarOrcamento(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope<any> {
  return {
    messageId: 'cmd-1',
    type: 'billing.GerarOrcamento',
    version: 1,
    sagaId: 'saga-1',
    correlationId: 'saga-1',
    causationId: null,
    osId: 'os-1',
    occurredAt: T0.toISOString(),
    producer: 'os-service',
    payload: {
      clientId: 'client-1',
      clientEmail: 'cliente@teste.com',
      vehicleId: 'v-1',
      items: [
        { kind: 'SERVICE', refId: 's-1', description: 'Troca de óleo', quantity: 1, unitPriceCents: 15000 },
        { kind: 'PART', refId: 'p-1', description: 'Filtro', quantity: 2, unitPriceCents: 5000 },
      ],
    },
    ...overrides,
  };
}

export function command(type: string, payload: Record<string, unknown>, messageId = `cmd-${type}`): MessageEnvelope {
  return { ...gerarOrcamento(), type, payload, messageId };
}
