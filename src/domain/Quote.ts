import { QuoteItemInput } from './messages';
import { AppError } from '../shared/AppError';

export enum QuoteStatus {
  AGUARDANDO_APROVACAO = 'AGUARDANDO_APROVACAO',
  APROVADO = 'APROVADO',
  RECUSADO = 'RECUSADO',
  CANCELADO = 'CANCELADO',
}

export type QuoteItem = QuoteItemInput;

/** Orçamento de uma OS. Valores sempre em centavos (inteiros). */
export class Quote {
  id: string;
  osId: string;
  sagaId: string;
  clientId: string;
  clientEmail: string;
  vehicleId: string;
  items: QuoteItem[];
  totalCents: number;
  status: QuoteStatus;
  expiresAt: string;
  paymentId: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;

  constructor(data: Partial<Quote>) {
    Object.assign(this, data);
    this.items = data.items ?? [];
    this.status = data.status ?? QuoteStatus.AGUARDANDO_APROVACAO;
    this.paymentId = data.paymentId ?? null;
    this.decisionReason = data.decisionReason ?? null;
  }

  static create(params: {
    id: string;
    osId: string;
    sagaId: string;
    clientId: string;
    clientEmail: string;
    vehicleId: string;
    items: QuoteItem[];
    now: Date;
    validityHours: number;
  }): Quote {
    if (!params.items.length) throw new AppError('Orçamento sem itens', 422);
    for (const item of params.items) {
      if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
        throw new AppError(`Preço inválido no item ${item.refId}`, 422);
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new AppError(`Quantidade inválida no item ${item.refId}`, 422);
      }
    }
    const totalCents = params.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0);
    const iso = params.now.toISOString();
    return new Quote({
      id: params.id,
      osId: params.osId,
      sagaId: params.sagaId,
      clientId: params.clientId,
      clientEmail: params.clientEmail,
      vehicleId: params.vehicleId,
      items: params.items,
      totalCents,
      status: QuoteStatus.AGUARDANDO_APROVACAO,
      expiresAt: new Date(params.now.getTime() + params.validityHours * 3_600_000).toISOString(),
      createdAt: iso,
      updatedAt: iso,
    });
  }

  isExpired(now: Date): boolean {
    return new Date(this.expiresAt).getTime() <= now.getTime();
  }

  /** Garante que o orçamento ainda pode receber decisão do cliente. */
  assertDecidable(now: Date): void {
    if (this.status !== QuoteStatus.AGUARDANDO_APROVACAO) {
      throw new AppError(`Orçamento já está ${this.status}`, 409);
    }
    if (this.isExpired(now)) throw new AppError('Orçamento expirado', 422);
  }
}
