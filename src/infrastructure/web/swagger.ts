import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

export function buildSwaggerSpec() {
  return swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Oficina Marimb0ndo — Billing Service',
        version: '1.0.0',
        description:
          'Orçamentos e pagamentos (Mercado Pago Checkout Pro). Participa da Saga orquestrada pelo os-service: ' +
          'recebe comandos via RabbitMQ (billing.commands) e publica eventos billing.* na exchange oficina.events.',
      },
      servers: [{ url: process.env.API_URL ?? '/billing', description: 'Via API Gateway (/billing)' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      tags: [{ name: 'Orçamentos' }, { name: 'Webhooks' }],
      paths: {
        '/webhooks/mercadopago': {
          post: {
            tags: ['Webhooks'],
            summary: 'Notificação de pagamento do Mercado Pago',
            description: 'Validada pelo header x-signature (HMAC). O status é sempre consultado na API do Mercado Pago.',
            parameters: [
              { in: 'query', name: 'type', schema: { type: 'string', example: 'payment' } },
              { in: 'query', name: 'data.id', schema: { type: 'string', example: '1234567890' } },
            ],
            responses: { 200: { description: 'Processado ou ignorado' }, 401: { description: 'Assinatura inválida' } },
          },
        },
      },
    },
    apis: [path.join(__dirname, 'app.ts'), path.join(__dirname, 'app.js')],
  });
}
