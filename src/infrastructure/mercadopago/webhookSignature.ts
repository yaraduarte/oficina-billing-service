import { InvalidWebhookSignatureError, WebhookSignatureValidator } from 'mercadopago';

export interface WebhookRequestParts {
  xSignature: string | string[] | undefined;
  xRequestId: string | string[] | undefined;
  dataId: string | string[] | undefined;
}

export type SignatureCheck = { valid: true } | { valid: false; reason: string };

/**
 * Valida a assinatura x-signature do webhook com o validador oficial do SDK
 * (HMAC-SHA256 sobre id + request-id + ts, com tolerância de horário contra replay).
 */
export function verifyWebhookSignature(parts: WebhookRequestParts, secret: string, toleranceSeconds = 300): SignatureCheck {
  try {
    WebhookSignatureValidator.validate({ ...parts, secret, toleranceSeconds });
    return { valid: true };
  } catch (err) {
    if (err instanceof InvalidWebhookSignatureError) return { valid: false, reason: err.reason };
    return { valid: false, reason: (err as Error).message };
  }
}
