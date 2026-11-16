import { MercadoPagoConfig, Payment as MpPayment, PaymentRefund, Preference } from 'mercadopago';
import {
  CheckoutRequest,
  CheckoutResult,
  GatewayPayment,
  IPaymentGateway,
  PermanentGatewayError,
  RefundResult,
} from '../../application/ports';

export interface MercadoPagoSettings {
  accessToken: string;
  /** URL pública do webhook (via API Gateway): .../billing/webhooks/mercadopago */
  notificationUrl?: string;
  /** Página para onde o cliente volta após pagar (sucesso/pendente/falha). */
  backUrl?: string;
  statementDescriptor?: string;
  timeoutMs?: number;
}

/** Clientes do SDK, injetáveis para teste. */
export interface MercadoPagoClients {
  preference: Pick<Preference, 'create'>;
  payment: Pick<MpPayment, 'get'>;
  refund: Pick<PaymentRefund, 'total'>;
}

export function createMercadoPagoClients(settings: MercadoPagoSettings): MercadoPagoClients {
  const config = new MercadoPagoConfig({ accessToken: settings.accessToken, options: { timeout: settings.timeoutMs ?? 5000 } });
  return {
    preference: new Preference(config),
    payment: new MpPayment(config),
    refund: new PaymentRefund(config),
  };
}

const toCents = (value: number | undefined) => Math.round((value ?? 0) * 100);

/** Status HTTP do erro do SDK, quando disponível. */
function httpStatusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; cause?: { status?: number } } | undefined;
  return e?.status ?? e?.statusCode ?? e?.cause?.status;
}

function messageOf(err: unknown): string {
  const e = err as { message?: string; error?: string } | undefined;
  return e?.message ?? e?.error ?? String(err);
}

/**
 * Adaptador do Mercado Pago — Checkout Pro.
 * - createCheckout: cria a preferência (itens do orçamento, external_reference = id do nosso pagamento)
 * - getPayment: consulta o pagamento informado no webhook (fonte da verdade do status)
 * - refund: estorno total com chave de idempotência
 */
export class MercadoPagoGateway implements IPaymentGateway {
  constructor(
    private readonly clients: MercadoPagoClients,
    private readonly settings: MercadoPagoSettings,
  ) {}

  async createCheckout({ paymentId, quote, expiresAt }: CheckoutRequest): Promise<CheckoutResult> {
    const back = this.settings.backUrl;
    const response = await this.clients.preference.create({
      body: {
        items: quote.items.map((item) => ({
          id: item.refId,
          title: item.description.slice(0, 250),
          quantity: item.quantity,
          unit_price: item.unitPriceCents / 100,
          currency_id: 'BRL',
          category_id: item.kind === 'SERVICE' ? 'services' : 'others',
        })),
        payer: { email: quote.clientEmail },
        external_reference: paymentId,
        metadata: { quote_id: quote.id, os_id: quote.osId, saga_id: quote.sagaId },
        expires: true,
        expiration_date_to: expiresAt,
        ...(this.settings.notificationUrl ? { notification_url: this.settings.notificationUrl } : {}),
        ...(back ? { back_urls: { success: back, pending: back, failure: back }, auto_return: 'approved' } : {}),
        statement_descriptor: this.settings.statementDescriptor ?? 'OFICINA MARIMB0NDO',
      },
      requestOptions: { idempotencyKey: `checkout-${paymentId}` },
    });

    if (!response.id || !response.init_point) {
      throw new Error('Mercado Pago não retornou a preferência de pagamento');
    }
    return { preferenceId: response.id, checkoutUrl: response.init_point };
  }

  async getPayment(gatewayPaymentId: string): Promise<GatewayPayment> {
    const p = await this.clients.payment.get({ id: gatewayPaymentId });
    return {
      id: String(p.id ?? gatewayPaymentId),
      status: p.status ?? 'unknown',
      statusDetail: p.status_detail ?? null,
      externalReference: p.external_reference ?? null,
      amountCents: toCents(p.transaction_amount),
    };
  }

  async refund(gatewayPaymentId: string, idempotencyKey: string): Promise<RefundResult> {
    try {
      const r = await this.clients.refund.total({ payment_id: gatewayPaymentId, requestOptions: { idempotencyKey } });
      return { refundId: String(r.id), amountCents: toCents(r.amount) };
    } catch (err) {
      const status = httpStatusOf(err);
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw new PermanentGatewayError(`Estorno recusado pelo Mercado Pago (${status}): ${messageOf(err)}`);
      }
      throw err;
    }
  }
}
