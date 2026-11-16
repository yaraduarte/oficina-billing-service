import { Commands, GerarOrcamentoPayload, MessageEnvelope } from '../domain/messages';
import { BillingService } from './BillingService';
import { Logger, silentLogger } from './ports';

/** Encaminha os comandos recebidos do orquestrador para o caso de uso correspondente. */
export class CommandDispatcher {
  constructor(
    private readonly billing: BillingService,
    private readonly logger: Logger = silentLogger,
  ) {}

  async handle(envelope: MessageEnvelope): Promise<void> {
    switch (envelope.type) {
      case Commands.GERAR_ORCAMENTO:
        await this.billing.generateQuote(envelope as unknown as MessageEnvelope<GerarOrcamentoPayload>);
        return;
      case Commands.CANCELAR_ORCAMENTO:
        await this.billing.cancelQuote(envelope as MessageEnvelope<{ quoteId?: string; reason?: string }>);
        return;
      case Commands.ESTORNAR_PAGAMENTO:
        await this.billing.refundPayment(envelope as MessageEnvelope<{ paymentId?: string; reason?: string }>);
        return;
      default:
        this.logger.warn('Comando desconhecido ignorado', { type: envelope.type, messageId: envelope.messageId });
    }
  }
}
