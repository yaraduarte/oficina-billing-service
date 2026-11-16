import 'express-async-errors';
import express, { Request, Response, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { BillingService } from '../../application/BillingService';
import { verifyWebhookSignature } from '../mercadopago/webhookSignature';
import { authMiddleware, errorHandler, originVerifyMiddleware } from './middlewares';
import { buildSwaggerSpec } from './swagger';
import { AppError } from '../../shared/AppError';

export interface AppDependencies {
  billing: BillingService;
  jwtSecret: string;
  originVerifySecret?: string;
  /** Assinatura secreta do webhook (painel do Mercado Pago). */
  webhookSecret?: string;
  /** Sem segredo de webhook, só aceita notificações não assinadas fora de produção. */
  allowUnsignedWebhooks?: boolean;
  isReady?: () => boolean;
  logger?: Pick<Console, 'warn' | 'error'>;
}

const first = (v: unknown): string | undefined => (Array.isArray(v) ? (v[0] as string) : (v as string | undefined));

export function createApp(deps: AppDependencies) {
  const app = express();
  const logger = deps.logger ?? console;

  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(originVerifyMiddleware(deps.originVerifySecret));

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(buildSwaggerSpec()));
  app.use(helmet());

  app.get('/health', (_req, res) => {
    const ready = deps.isReady ? deps.isReady() : true;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      service: 'billing-service',
      environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook do Mercado Pago (rota pública no Gateway, autenticada pela assinatura)
  // ---------------------------------------------------------------------------
  app.post('/webhooks/mercadopago', async (req: Request, res: Response) => {
    const type = first(req.query.type) ?? first(req.query.topic) ?? req.body?.type;
    const dataId = first(req.query['data.id']) ?? first(req.query.id) ?? req.body?.data?.id;

    if (deps.webhookSecret) {
      const check = verifyWebhookSignature(
        { xSignature: req.header('x-signature'), xRequestId: req.header('x-request-id'), dataId },
        deps.webhookSecret,
      );
      if (!check.valid) {
        logger.warn('[Webhook] Assinatura inválida', { reason: check.reason, requestId: req.header('x-request-id') });
        throw new AppError('Assinatura do webhook inválida', 401);
      }
    } else if (!deps.allowUnsignedWebhooks) {
      throw new AppError('Webhook do Mercado Pago não configurado', 503);
    }

    if (type !== 'payment' || !dataId) {
      res.status(200).json({ status: 'ignored', reason: `tipo ${type ?? 'desconhecido'}` });
      return;
    }
    const result = await deps.billing.processPaymentNotification(String(dataId));
    res.status(200).json({ status: result.handled ? 'processed' : 'ignored', paymentStatus: result.status ?? null });
  });

  // ---------------------------------------------------------------------------
  // Orçamentos (cliente e funcionários, via Gateway com authorizer JWT)
  // ---------------------------------------------------------------------------
  const quotes = Router();
  quotes.use(authMiddleware(deps.jwtSecret));

  /**
   * @swagger
   * /orcamentos:
   *   get:
   *     summary: Lista orçamentos de uma OS
   *     tags: [Orçamentos]
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: query, name: osId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: Lista (clientes veem apenas os próprios) }
   *       422: { description: osId obrigatório }
   */
  quotes.get('/', async (req, res) => {
    const osId = first(req.query.osId);
    if (!osId) throw new AppError('Parâmetro osId é obrigatório', 422);
    res.json({ status: 'success', data: await deps.billing.listByServiceOrder(osId, req.requester!) });
  });

  /**
   * @swagger
   * /orcamentos/{id}:
   *   get:
   *     summary: Detalha um orçamento e o pagamento associado
   *     tags: [Orçamentos]
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: Orçamento encontrado }
   *       403: { description: Orçamento de outro cliente }
   *       404: { description: Não encontrado }
   */
  quotes.get('/:id', async (req, res) => {
    res.json({ status: 'success', data: await deps.billing.getQuote(req.params.id, req.requester!) });
  });

  /**
   * @swagger
   * /orcamentos/{id}/aprovar:
   *   post:
   *     summary: Aprova o orçamento e gera o link de pagamento (Mercado Pago Checkout Pro)
   *     description: Publica billing.OrcamentoAprovado. O cliente paga no link `checkoutUrl`; a confirmação chega pelo webhook.
   *     tags: [Orçamentos]
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: "Aprovado — retorna paymentId e checkoutUrl" }
   *       409: { description: Orçamento já decidido }
   *       422: { description: Orçamento expirado }
   */
  quotes.post('/:id/aprovar', async (req, res) => {
    const { quote, payment } = await deps.billing.approveQuote(req.params.id, req.requester!);
    res.json({
      status: 'success',
      data: { quoteId: quote.id, status: quote.status, paymentId: payment.id, checkoutUrl: payment.checkoutUrl, amountCents: payment.amountCents },
    });
  });

  /**
   * @swagger
   * /orcamentos/{id}/recusar:
   *   post:
   *     summary: Recusa o orçamento (a Saga cancela a OS)
   *     tags: [Orçamentos]
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema: { type: object, properties: { reason: { type: string, example: "Valor acima do esperado" } } }
   *     responses:
   *       200: { description: Recusado }
   *       409: { description: Orçamento já decidido }
   */
  quotes.post('/:id/recusar', async (req, res) => {
    const quote = await deps.billing.rejectQuote(req.params.id, req.requester!, req.body?.reason);
    res.json({ status: 'success', data: { quoteId: quote.id, status: quote.status } });
  });

  app.use('/orcamentos', quotes);
  app.use(errorHandler);
  return app;
}
