import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { Quote, QuoteStatus } from '../domain/Quote';
import { Payment, PaymentStatus } from '../domain/Payment';
import { Events, EventType, GerarOrcamentoPayload, MessageEnvelope } from '../domain/messages';
import { AppError } from '../shared/AppError';
import {
  IEventPublisher,
  IPaymentGateway,
  IPaymentRepository,
  IQuoteRepository,
  Logger,
  PermanentGatewayError,
  silentLogger,
} from './ports';

export const PRODUCER = 'billing-service';
/** Namespace fixo para gerar messageIds determinísticos (UUID v5). */
const EVENT_NAMESPACE = '6f0c7b0e-5b8a-4b8e-9d3c-0f1c2a3b4c5d';

export interface Requester {
  sub: string;
  type: 'client' | 'staff';
}

export interface BillingOptions {
  quoteValidityHours: number;
  idGenerator?: () => string;
  clock?: () => Date;
  logger?: Logger;
}

const APPROVED_MP_STATUSES = ['approved'];
const REFUSED_MP_STATUSES = ['rejected', 'cancelled'];

/**
 * Casos de uso do billing-service (participante da Saga orquestrada pelo os-service).
 *
 * Idempotência: cada operação aplica a transição de estado só uma vez (gravação condicional)
 * e sempre (re)publica o evento correspondente ao estado atual com messageId determinístico.
 * Assim, reentregas de comandos e webhooks repetidos do Mercado Pago não duplicam efeitos,
 * e uma falha ao publicar é corrigida na próxima tentativa.
 */
export class BillingService {
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(
    private readonly quotes: IQuoteRepository,
    private readonly payments: IPaymentRepository,
    private readonly gateway: IPaymentGateway,
    private readonly publisher: IEventPublisher,
    private readonly options: BillingOptions,
  ) {
    this.newId = options.idGenerator ?? uuidv4;
    this.now = options.clock ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  // ---------------------------------------------------------------------------
  // Comandos da Saga
  // ---------------------------------------------------------------------------

  /** billing.GerarOrcamento → cria o orçamento e publica OrcamentoGerado. */
  async generateQuote(command: MessageEnvelope<GerarOrcamentoPayload>): Promise<Quote> {
    const existing = await this.quotes.findBySagaId(command.sagaId, command.osId);
    let quote = existing;
    if (!quote) {
      const { clientId, clientEmail, vehicleId, items } = command.payload;
      quote = Quote.create({
        id: this.newId(),
        osId: command.osId,
        sagaId: command.sagaId,
        clientId,
        clientEmail,
        vehicleId,
        items: items ?? [],
        now: this.now(),
        validityHours: this.options.quoteValidityHours,
      });
      const created = await this.quotes.create(quote);
      if (!created) quote = (await this.quotes.findBySagaId(command.sagaId, command.osId)) ?? quote;
      this.logger.info('Orçamento gerado', { quoteId: quote.id, osId: quote.osId, totalCents: quote.totalCents });
    }
    await this.emit(quote, Events.ORCAMENTO_GERADO, quote.id, command.messageId, {
      quoteId: quote.id,
      totalCents: quote.totalCents,
      expiresAt: quote.expiresAt,
    });
    return quote;
  }

  /** billing.CancelarOrcamento (compensação) → cancela orçamento e checkout pendente. */
  async cancelQuote(command: MessageEnvelope<{ quoteId?: string | null; reason?: string }>): Promise<void> {
    const quote = command.payload.quoteId
      ? await this.quotes.findById(command.payload.quoteId)
      : await this.quotes.findBySagaId(command.sagaId, command.osId);

    if (quote && quote.status !== QuoteStatus.CANCELADO && quote.status !== QuoteStatus.RECUSADO) {
      quote.status = QuoteStatus.CANCELADO;
      quote.decisionReason = command.payload.reason ?? 'Cancelado pela saga';
      quote.updatedAt = this.now().toISOString();
      await this.quotes.saveIfStatus(quote, [QuoteStatus.AGUARDANDO_APROVACAO, QuoteStatus.APROVADO]);

      const payment = await this.payments.findByQuoteId(quote.id);
      if (payment && payment.status === PaymentStatus.PENDENTE) {
        payment.status = PaymentStatus.CANCELADO;
        payment.updatedAt = quote.updatedAt;
        await this.payments.saveIfStatus(payment, [PaymentStatus.PENDENTE]);
      }
    }

    const quoteId = quote?.id ?? command.payload.quoteId ?? null;
    await this.publisher.publish(
      this.envelope(command.sagaId, command.osId, Events.ORCAMENTO_CANCELADO, quoteId ?? command.sagaId, command.messageId, {
        quoteId,
      }),
    );
  }

  /** billing.EstornarPagamento (compensação) → estorno total no Mercado Pago. */
  async refundPayment(command: MessageEnvelope<{ paymentId?: string | null; reason?: string }>): Promise<void> {
    const payment = command.payload.paymentId ? await this.payments.findById(command.payload.paymentId) : null;

    if (!payment || (payment.status !== PaymentStatus.APROVADO && payment.status !== PaymentStatus.ESTORNADO)) {
      // Nada foi cobrado: a compensação está concluída sem chamar o gateway
      this.logger.warn('Estorno sem cobrança a desfazer', { paymentId: command.payload.paymentId, status: payment?.status });
      await this.publisher.publish(
        this.envelope(command.sagaId, command.osId, Events.PAGAMENTO_ESTORNADO, payment?.id ?? command.sagaId, command.messageId, {
          paymentId: payment?.id ?? command.payload.paymentId ?? null,
          mpRefundId: null,
          amountCents: 0,
        }),
      );
      return;
    }

    if (payment.status === PaymentStatus.APROVADO) {
      try {
        const refund = await this.gateway.refund(payment.mpPaymentId as string, `refund-${payment.id}`);
        payment.status = PaymentStatus.ESTORNADO;
        payment.refundId = refund.refundId;
        payment.updatedAt = this.now().toISOString();
        await this.payments.saveIfStatus(payment, [PaymentStatus.APROVADO]);
        this.logger.info('Pagamento estornado', { paymentId: payment.id, refundId: refund.refundId });
      } catch (err) {
        if (err instanceof PermanentGatewayError) {
          await this.emit(payment, Events.ESTORNO_FALHOU, payment.id, command.messageId, {
            paymentId: payment.id,
            error: err.message,
          });
          return;
        }
        throw err; // transitório: o consumidor tenta de novo
      }
    }

    await this.emit(payment, Events.PAGAMENTO_ESTORNADO, payment.id, command.messageId, {
      paymentId: payment.id,
      mpRefundId: payment.refundId,
      amountCents: payment.amountCents,
    });
  }

  // ---------------------------------------------------------------------------
  // Ações do cliente (HTTP)
  // ---------------------------------------------------------------------------

  async getQuote(id: string, requester: Requester): Promise<{ quote: Quote; payment: Payment | null }> {
    const quote = await this.quotes.findById(id);
    if (!quote) throw new AppError('Orçamento não encontrado', 404);
    this.assertCanAccess(quote, requester);
    return { quote, payment: await this.payments.findByQuoteId(quote.id) };
  }

  async listByServiceOrder(osId: string, requester: Requester): Promise<Quote[]> {
    const list = await this.quotes.findByOsId(osId);
    return list.filter((q) => requester.type === 'staff' || q.clientId === requester.sub);
  }

  /** Cliente aprova → cria o checkout (Checkout Pro) e publica OrcamentoAprovado com o link. */
  async approveQuote(id: string, requester: Requester): Promise<{ quote: Quote; payment: Payment }> {
    const quote = await this.quotes.findById(id);
    if (!quote) throw new AppError('Orçamento não encontrado', 404);
    this.assertCanAccess(quote, requester);

    if (quote.status === QuoteStatus.APROVADO) {
      const payment = await this.payments.findByQuoteId(quote.id);
      if (payment) return { quote, payment }; // aprovação repetida: devolve o mesmo checkout
    }
    quote.assertDecidable(this.now());

    const paymentId = this.newId();
    let checkout;
    try {
      checkout = await this.gateway.createCheckout({ paymentId, quote, expiresAt: quote.expiresAt });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      this.logger.warn('Falha ao criar checkout no Mercado Pago', { quoteId: quote.id, status: e?.status, error: e?.message });
      throw new AppError('Não foi possível gerar o link de pagamento no Mercado Pago. Tente novamente.', 502);
    }
    const nowIso = this.now().toISOString();
    const payment = new Payment({
      id: paymentId,
      quoteId: quote.id,
      osId: quote.osId,
      sagaId: quote.sagaId,
      amountCents: quote.totalCents,
      status: PaymentStatus.PENDENTE,
      preferenceId: checkout.preferenceId,
      checkoutUrl: checkout.checkoutUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    quote.status = QuoteStatus.APROVADO;
    quote.paymentId = paymentId;
    quote.updatedAt = nowIso;
    if (!(await this.quotes.saveIfStatus(quote, [QuoteStatus.AGUARDANDO_APROVACAO]))) {
      throw new AppError('Orçamento foi alterado por outra operação, tente novamente', 409);
    }
    await this.payments.create(payment);

    await this.emit(quote, Events.ORCAMENTO_APROVADO, quote.id, null, {
      quoteId: quote.id,
      paymentId,
      checkoutUrl: checkout.checkoutUrl,
    });
    return { quote, payment };
  }

  async rejectQuote(id: string, requester: Requester, reason?: string): Promise<Quote> {
    const quote = await this.quotes.findById(id);
    if (!quote) throw new AppError('Orçamento não encontrado', 404);
    this.assertCanAccess(quote, requester);
    if (quote.status !== QuoteStatus.RECUSADO) {
      quote.assertDecidable(this.now());
      quote.status = QuoteStatus.RECUSADO;
      quote.decisionReason = reason?.slice(0, 500) || 'Recusado pelo cliente';
      quote.updatedAt = this.now().toISOString();
      if (!(await this.quotes.saveIfStatus(quote, [QuoteStatus.AGUARDANDO_APROVACAO]))) {
        throw new AppError('Orçamento foi alterado por outra operação, tente novamente', 409);
      }
    }
    await this.emit(quote, Events.ORCAMENTO_RECUSADO, quote.id, null, { quoteId: quote.id, reason: quote.decisionReason });
    return quote;
  }

  // ---------------------------------------------------------------------------
  // Webhook do Mercado Pago
  // ---------------------------------------------------------------------------

  /**
   * Processa a notificação de pagamento: consulta o pagamento no Mercado Pago (nunca confia
   * no corpo do webhook) e confirma ou recusa conforme o status.
   */
  async processPaymentNotification(gatewayPaymentId: string): Promise<{ handled: boolean; status?: string }> {
    const mp = await this.gateway.getPayment(gatewayPaymentId);
    if (!mp.externalReference) {
      this.logger.warn('Pagamento do Mercado Pago sem external_reference', { mpPaymentId: mp.id });
      return { handled: false };
    }
    const payment = await this.payments.findById(mp.externalReference);
    if (!payment) {
      this.logger.warn('Pagamento desconhecido no webhook', { externalReference: mp.externalReference });
      return { handled: false };
    }

    if (APPROVED_MP_STATUSES.includes(mp.status)) {
      if (payment.status === PaymentStatus.PENDENTE || payment.status === PaymentStatus.RECUSADO) {
        payment.status = PaymentStatus.APROVADO;
        payment.mpPaymentId = mp.id;
        payment.mpStatus = mp.status;
        payment.mpStatusDetail = mp.statusDetail;
        payment.paidAt = this.now().toISOString();
        payment.updatedAt = payment.paidAt;
        await this.payments.saveIfStatus(payment, [PaymentStatus.PENDENTE, PaymentStatus.RECUSADO]);
        this.logger.info('Pagamento aprovado', { paymentId: payment.id, mpPaymentId: mp.id });
      }
      if (payment.status === PaymentStatus.APROVADO) {
        await this.emit(payment, Events.PAGAMENTO_CONFIRMADO, payment.id, null, {
          paymentId: payment.id,
          quoteId: payment.quoteId,
          mpPaymentId: payment.mpPaymentId,
          amountCents: payment.amountCents,
          paidAt: payment.paidAt,
        });
      }
      return { handled: true, status: payment.status };
    }

    if (REFUSED_MP_STATUSES.includes(mp.status)) {
      if (payment.status === PaymentStatus.PENDENTE) {
        payment.status = PaymentStatus.RECUSADO;
        payment.mpPaymentId = mp.id;
        payment.mpStatus = mp.status;
        payment.mpStatusDetail = mp.statusDetail;
        payment.updatedAt = this.now().toISOString();
        await this.payments.saveIfStatus(payment, [PaymentStatus.PENDENTE]);
      }
      if (payment.status === PaymentStatus.RECUSADO) {
        await this.emit(payment, Events.PAGAMENTO_RECUSADO, payment.id, null, {
          paymentId: payment.id,
          quoteId: payment.quoteId,
          mpStatus: payment.mpStatus,
          mpStatusDetail: payment.mpStatusDetail,
        });
      }
      return { handled: true, status: payment.status };
    }

    // pending / in_process / refunded etc.: nada a fazer na Saga
    return { handled: false, status: mp.status };
  }

  // ---------------------------------------------------------------------------

  private assertCanAccess(quote: Quote, requester: Requester): void {
    if (requester.type === 'client' && quote.clientId !== requester.sub) {
      throw new AppError('Orçamento pertence a outro cliente', 403);
    }
  }

  private emit(
    aggregate: { sagaId: string; osId: string },
    type: EventType,
    aggregateId: string,
    causationId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.publisher.publish(this.envelope(aggregate.sagaId, aggregate.osId, type, aggregateId, causationId, payload));
  }

  private envelope(
    sagaId: string,
    osId: string,
    type: EventType,
    aggregateId: string,
    causationId: string | null,
    payload: Record<string, unknown>,
  ): MessageEnvelope {
    return {
      messageId: uuidv5(`${aggregateId}:${type}`, EVENT_NAMESPACE),
      type,
      version: 1,
      sagaId,
      correlationId: sagaId,
      causationId,
      osId,
      occurredAt: this.now().toISOString(),
      producer: PRODUCER,
      payload,
    };
  }
}
