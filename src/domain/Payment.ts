export enum PaymentStatus {
  /** Checkout criado no Mercado Pago, aguardando o cliente pagar. */
  PENDENTE = 'PENDENTE',
  APROVADO = 'APROVADO',
  RECUSADO = 'RECUSADO',
  ESTORNADO = 'ESTORNADO',
  /** Orçamento cancelado antes do pagamento. */
  CANCELADO = 'CANCELADO',
}

export class Payment {
  id: string;
  quoteId: string;
  osId: string;
  sagaId: string;
  amountCents: number;
  status: PaymentStatus;
  preferenceId: string;
  checkoutUrl: string;
  mpPaymentId: string | null;
  mpStatus: string | null;
  mpStatusDetail: string | null;
  refundId: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;

  constructor(data: Partial<Payment>) {
    Object.assign(this, data);
    this.status = data.status ?? PaymentStatus.PENDENTE;
    this.mpPaymentId = data.mpPaymentId ?? null;
    this.mpStatus = data.mpStatus ?? null;
    this.mpStatusDetail = data.mpStatusDetail ?? null;
    this.refundId = data.refundId ?? null;
    this.paidAt = data.paidAt ?? null;
  }
}
