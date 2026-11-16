/**
 * Contratos de mensagens da Saga da OS (cópia local do contrato publicado em
 * oficinaMarimbondo/docs/fase4/EVENTOS.md — fonte da verdade).
 */

export const Exchanges = {
  COMMANDS: 'oficina.commands',
  EVENTS: 'oficina.events',
  DLX: 'oficina.dlx',
} as const;

export const BILLING_ROUTING_KEY = 'billing';

export const Commands = {
  GERAR_ORCAMENTO: 'billing.GerarOrcamento',
  CANCELAR_ORCAMENTO: 'billing.CancelarOrcamento',
  ESTORNAR_PAGAMENTO: 'billing.EstornarPagamento',
} as const;

export const Events = {
  ORCAMENTO_GERADO: 'billing.OrcamentoGerado',
  ORCAMENTO_APROVADO: 'billing.OrcamentoAprovado',
  ORCAMENTO_RECUSADO: 'billing.OrcamentoRecusado',
  ORCAMENTO_CANCELADO: 'billing.OrcamentoCancelado',
  PAGAMENTO_CONFIRMADO: 'billing.PagamentoConfirmado',
  PAGAMENTO_RECUSADO: 'billing.PagamentoRecusado',
  PAGAMENTO_ESTORNADO: 'billing.PagamentoEstornado',
  ESTORNO_FALHOU: 'billing.EstornoFalhou',
} as const;

export type EventType = (typeof Events)[keyof typeof Events];

export interface MessageEnvelope<P = Record<string, unknown>> {
  messageId: string;
  type: string;
  version: number;
  sagaId: string;
  correlationId: string;
  causationId: string | null;
  osId: string;
  occurredAt: string;
  producer: string;
  payload: P;
}

export interface QuoteItemInput {
  kind: 'SERVICE' | 'PART';
  refId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface GerarOrcamentoPayload {
  clientId: string;
  clientEmail: string;
  vehicleId: string;
  items: QuoteItemInput[];
}
