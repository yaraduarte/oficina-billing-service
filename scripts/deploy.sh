#!/bin/bash
# Deploy do billing-service no k3s (executado na EC2 via SSH pelo pipeline).
# Uso: deploy.sh <namespace> <imagem> <manifesto>
# Variáveis esperadas (vindas dos secrets do GitHub):
#   MERCADO_PAGO_ACCESS_TOKEN, MERCADO_PAGO_WEBHOOK_SECRET, MERCADO_PAGO_NOTIFICATION_URL (opcional),
#   NEW_RELIC_LICENSE_KEY (opcional), APP_ENV
set -euo pipefail

NS="$1"
IMAGE="$2"
MANIFEST="$3"
K="sudo kubectl"
SUFFIX=$([ "$NS" = "oficina-marimb0ndo" ] && echo "" || echo "-hml")

# Segredos compartilhados com o os-service (já existentes no namespace)
JWT_SECRET=$($K get secret oficina-secret -n "$NS" -o jsonpath='{.data.JWT_SECRET}' | base64 -d)
ORIGIN_VERIFY_SECRET=$($K get secret oficina-secret -n "$NS" -o jsonpath='{.data.ORIGIN_VERIFY_SECRET}' 2>/dev/null | base64 -d || true)
RABBITMQ_URL=$($K get secret rabbitmq-credentials -n "$NS" -o jsonpath='{.data.url}' 2>/dev/null | base64 -d || true)

$K create configmap billing-config -n "$NS" \
  --from-literal=NODE_ENV=production \
  --from-literal=APP_ENV="${APP_ENV:-production}" \
  --from-literal=PORT=3000 \
  --from-literal=AWS_REGION=us-east-1 \
  --from-literal=QUOTES_TABLE="billing-quotes${SUFFIX}" \
  --from-literal=PAYMENTS_TABLE="billing-payments${SUFFIX}" \
  --from-literal=QUOTE_VALIDITY_HOURS=72 \
  --from-literal=MERCADO_PAGO_NOTIFICATION_URL="${MERCADO_PAGO_NOTIFICATION_URL:-}" \
  --from-literal="NEW_RELIC_APP_NAME=Oficina Marimbondo Billing${SUFFIX:+ (HML)}" \
  --dry-run=client -o yaml | $K apply -f -

$K create secret generic billing-secret -n "$NS" \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=ORIGIN_VERIFY_SECRET="$ORIGIN_VERIFY_SECRET" \
  --from-literal=RABBITMQ_URL="$RABBITMQ_URL" \
  --from-literal=MERCADO_PAGO_ACCESS_TOKEN="${MERCADO_PAGO_ACCESS_TOKEN:-}" \
  --from-literal=MERCADO_PAGO_WEBHOOK_SECRET="${MERCADO_PAGO_WEBHOOK_SECRET:-}" \
  --from-literal=NEW_RELIC_LICENSE_KEY="${NEW_RELIC_LICENSE_KEY:-}" \
  --dry-run=client -o yaml | $K apply -f -

sed -e "s|__NAMESPACE__|${NS}|g" -e "s|__IMAGE__|${IMAGE}|g" "$MANIFEST" | $K apply -f -
$K rollout restart deployment/billing-service -n "$NS"
$K rollout status deployment/billing-service -n "$NS" --timeout=180s
echo "billing-service atualizado em ${NS} com ${IMAGE}"
