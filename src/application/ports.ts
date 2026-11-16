import { Quote, QuoteStatus } from '../domain/Quote';
import { Payment, PaymentStatus } from '../domain/Payment';
import { MessageEnvelope } from '../domain/messages';

export interface IQuoteRepository {
  findById(id: string): Promise<Quote | null>;
  findBySagaId(sagaId: string, osId: string): Promise<Quote | null>;
  findByOsId(osId: string): Promise<Quote[]>;
  /** Insere apenas se ainda não existir (idempotência na criação). */
  create(quote: Quote): Promise<boolean>;
  /** Grava somente se o status atual estiver em `expected` (controle de concorrência). */
  saveIfStatus(quote: Quote, expected: QuoteStatus[]): Promise<boolean>;
}

export interface IPaymentRepository {
  findById(id: string): Promise<Payment | null>;
  findByQuoteId(quoteId: string): Promise<Payment | null>;
  create(payment: Payment): Promise<boolean>;
  saveIfStatus(payment: Payment, expected: PaymentStatus[]): Promise<boolean>;
}

/** Pagamento como o Mercado Pago o reporta. */
export interface GatewayPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  externalReference: string | null;
  amountCents: number;
}

export interface CheckoutRequest {
  paymentId: string;
  quote: Quote;
  expiresAt: string;
}

export interface CheckoutResult {
  preferenceId: string;
  checkoutUrl: string;
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
}

/** Erro definitivo do gateway (ex.: pagamento não reembolsável) — não adianta tentar de novo. */
export class PermanentGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentGatewayError';
  }
}

export interface IPaymentGateway {
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  getPayment(gatewayPaymentId: string): Promise<GatewayPayment>;
  refund(gatewayPaymentId: string, idempotencyKey: string): Promise<RefundResult>;
}

export interface IEventPublisher {
  publish(envelope: MessageEnvelope): Promise<void>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };
