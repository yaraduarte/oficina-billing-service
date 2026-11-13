import 'dotenv/config';

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export interface Config {
  port: number;
  isProduction: boolean;
  jwtSecret: string;
  originVerifySecret?: string;
  rabbitUrl?: string;
  quoteValidityHours: number;
  dynamo: { region: string; endpoint?: string; quotesTable: string; paymentsTable: string; autoCreateTables: boolean };
  mercadoPago: { accessToken: string; webhookSecret?: string; notificationUrl?: string; backUrl?: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT ?? 3000),
    isProduction,
    jwtSecret: isProduction ? required('JWT_SECRET', env) : env.JWT_SECRET ?? 'dev-secret',
    originVerifySecret: env.ORIGIN_VERIFY_SECRET || undefined,
    rabbitUrl: env.RABBITMQ_URL || undefined,
    quoteValidityHours: Number(env.QUOTE_VALIDITY_HOURS ?? 72),
    dynamo: {
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.DYNAMODB_ENDPOINT || undefined,
      quotesTable: env.QUOTES_TABLE ?? 'billing-quotes',
      paymentsTable: env.PAYMENTS_TABLE ?? 'billing-payments',
      autoCreateTables: env.DYNAMODB_AUTO_CREATE === 'true',
    },
    mercadoPago: {
      accessToken: isProduction ? required('MERCADO_PAGO_ACCESS_TOKEN', env) : env.MERCADO_PAGO_ACCESS_TOKEN ?? '',
      webhookSecret: env.MERCADO_PAGO_WEBHOOK_SECRET || undefined,
      notificationUrl: env.MERCADO_PAGO_NOTIFICATION_URL || undefined,
      backUrl: env.MERCADO_PAGO_BACK_URL || undefined,
    },
  };
}
