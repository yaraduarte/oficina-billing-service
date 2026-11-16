# oficina-billing-service

**Billing Service** da Oficina Marimb0ndo (FIAP SOAT — Tech Challenge Fase 4): orçamentos, aprovação pelo cliente e pagamentos com **Mercado Pago Checkout Pro**, persistidos em **DynamoDB** (banco NoSQL do projeto).

É participante da **Saga orquestrada** pelo os-service: recebe comandos pelo RabbitMQ e publica eventos `billing.*`. Visão geral, contratos e decisões: [oficinaMarimbondo/docs/fase4](https://github.com/yaraduarte/oficinaMarimbondo/tree/homolog/docs/fase4) (ADR-005 Saga, ADR-006 RabbitMQ, ADR-007 bancos).

## Tecnologias

| Tecnologia | Uso |
|---|---|
| Node.js 22 + TypeScript + Express | API HTTP |
| Mercado Pago SDK v2 (`mercadopago`) | Checkout Pro, consulta de pagamento, estorno, validação de webhook |
| DynamoDB (`@aws-sdk/lib-dynamodb`) | Tabelas `billing-quotes` e `billing-payments` |
| RabbitMQ (`amqplib`) | Comandos e eventos da Saga |
| New Relic | APM + trace distribuído através das mensagens |
| Jest + Supertest | Testes (cobertura mínima de 80% exigida no CI) |

## Por que Checkout Pro

| Opção | Encaixe |
|---|---|
| **Checkout Pro** ✅ | O cliente paga numa página do Mercado Pago (cartão, Pix, boleto). O backend só cria a *preferência* e recebe o webhook. Não exige front-end, e os dados de cartão não passam pelo nosso sistema. |
| Checkout API / Bricks | O formulário de pagamento fica dentro da nossa aplicação: exige front-end e coloca dados de cartão no escopo de segurança. |
| QR Code / Point | Pensados para venda presencial. |

## Arquitetura

```
src/
├── domain/            Quote, Payment, contratos de mensagens (cópia de EVENTOS.md)
├── application/       BillingService (casos de uso), CommandDispatcher, portas
└── infrastructure/
    ├── mercadopago/   MercadoPagoGateway (Checkout Pro) + validação x-signature
    ├── dynamodb/      repositórios com gravação condicional + criação de tabelas (dev)
    ├── messaging/     RabbitMQ: consumidor billing.commands (retry/DLQ) e publicador
    ├── observability/ New Relic (trace distribuído via headers AMQP)
    └── web/           Express: orçamentos, webhook, Swagger, JWT, x-origin-verify
```

## Participação na Saga

```
os-service ──cmd billing.GerarOrcamento──► grava orçamento ──► evt OrcamentoGerado
Cliente: POST /orcamentos/{id}/aprovar ──► cria preferência no MP (external_reference = paymentId)
                                       ──► evt OrcamentoAprovado { checkoutUrl }
Cliente paga no Checkout Pro ──► MP chama POST /webhooks/mercadopago
   valida x-signature ──► GET /v1/payments/{id} (fonte da verdade)
   approved ──► evt PagamentoConfirmado      rejected/cancelled ──► evt PagamentoRecusado
Cliente: POST /orcamentos/{id}/recusar ──► evt OrcamentoRecusado

Compensações (comandos do orquestrador):
  billing.EstornarPagamento ──► estorno total no MP (X-Idempotency-Key) ──► evt PagamentoEstornado
                                 (erro definitivo do MP ──► evt EstornoFalhou)
  billing.CancelarOrcamento ──► orçamento e checkout pendente cancelados ──► evt OrcamentoCancelado
```

**Idempotência:**
- Cada transição de estado usa uma gravação condicional no DynamoDB (`ConditionExpression` sobre o status), então só acontece uma vez.
- O evento correspondente é (re)publicado com um **messageId determinístico** (UUID v5 de `id + tipo`).
- Assim, comandos reentregues pelo RabbitMQ e webhooks repetidos pelo Mercado Pago não duplicam cobranças, estornos nem eventos: o orquestrador descarta o messageId repetido.

## API (via API Gateway em `/billing`)

| Método | Rota | Autorização | Descrição |
|---|---|---|---|
| GET | `/orcamentos?osId=` | JWT | Orçamentos da OS (o cliente vê só os próprios) |
| GET | `/orcamentos/{id}` | JWT | Orçamento e pagamento |
| POST | `/orcamentos/{id}/aprovar` | JWT | Gera o link do Checkout Pro |
| POST | `/orcamentos/{id}/recusar` | JWT | Recusa (a Saga cancela a OS) |
| POST | `/webhooks/mercadopago` | assinatura `x-signature` | Notificação de pagamento |
| GET | `/health` | — | Saúde (degradado sem broker) |

Swagger em `/api-docs`.

## Mercado Pago — configuração

1. No [painel de desenvolvedor](https://www.mercadopago.com.br/developers/panel), crie a aplicação (Pagamentos online → Checkout Pro) e as **contas de teste** (vendedor e comprador).
2. Logado com o **vendedor de teste**, copie o *Access Token* das credenciais de produção dessa conta (começa com `APP_USR-`).
3. Em **Webhooks**:
   - URL: `https://<api-gateway>/billing/webhooks/mercadopago`
   - Evento: *Pagamentos*
   - Copie a **assinatura secreta**.
4. No GitHub (`Settings → Secrets and variables → Actions`):

| Nome | Tipo | Valor |
|---|---|---|
| `MERCADO_PAGO_ACCESS_TOKEN` | secret | Access Token do vendedor de teste |
| `MERCADO_PAGO_WEBHOOK_SECRET` | secret | Assinatura secreta do webhook |
| `MERCADO_PAGO_NOTIFICATION_URL` | variable (por environment) | URL do webhook no Gateway |

### Pagando nos testes

Faça login no checkout com o **comprador de teste** e use um cartão de teste do Mercado Pago (ex.: Mastercard `5031 4332 1540 6351`, CVV `123`, validade `11/30`, CPF `12345678909`). O nome do titular define o resultado:
- `APRO`: aprovado → `PagamentoConfirmado`
- `OTHE`: recusado → `PagamentoRecusado` → a Saga compensa

Confira os cartões vigentes na [documentação](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/integration-test/test-cards).

## Executar localmente

```bash
cp .env.example .env          # preencha MERCADO_PAGO_ACCESS_TOKEN para gerar checkouts
docker compose up -d dynamodb rabbitmq
npm ci
npm run dev                   # cria as tabelas no DynamoDB Local (DYNAMODB_AUTO_CREATE=true)
```

Para o fluxo completo, rode o os-service apontando para o mesmo RabbitMQ: abrir uma OS gera o orçamento aqui automaticamente.

## Testes

```bash
npm test
```

| Métrica | Cobertura |
|---|---|
| Statements | 98,6% |
| Branches | 95,9% |
| Funções | 93,8% |
| Linhas | 99,6% |

73 testes:
- **casos de uso**: caminho feliz, recusa, compensações e idempotência;
- **API com supertest**: JWT, acesso por dono do orçamento, `x-origin-verify` e webhook com assinatura HMAC real (válida, segredo errado e replay);
- **adaptadores**: Mercado Pago com o SDK simulado, DynamoDB com o cliente simulado, RabbitMQ, New Relic e composição do serviço.

Teste de ponta a ponta realizado localmente com os-service, billing-service, PostgreSQL, RabbitMQ e DynamoDB Local reais:
- OS aberta no os-service gerou o orçamento no DynamoDB (R$ 299,80);
- autorização por cliente funcionou;
- a recusa cancelou a OS e compensou a saga;
- falha do Mercado Pago na aprovação não alterou o estado.

## CI/CD e ambientes

`.github/workflows/ci-cd.yml`:

| Evento | Jobs |
|---|---|
| PR para `homolog`/`main` | **Testes** (build + Jest com mínimo de 80%, resumo de cobertura no job) |
| Merge em `homolog` | Testes → imagem `:hml-<sha>` → deploy no namespace `oficina-hml` |
| Merge em `main` | Testes → imagem `:<sha>` → deploy no namespace `oficina-marimb0ndo` |

O deploy usa `scripts/deploy.sh` com `k8s/billing.yaml` (Deployment, Service, HPA, Ingress `/billing` com strip-prefix). Os segredos compartilhados (JWT, `x-origin-verify`, RabbitMQ) são lidos do namespace, e os do Mercado Pago vêm dos secrets do GitHub.

Secrets necessários: `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `K3S_HOST`, `K3S_SSH_PRIVATE_KEY`, `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_WEBHOOK_SECRET`, `NEW_RELIC_LICENSE_KEY`.

## Fluxo de branches

`feature/*` → PR → `homolog` (deploy homologação) → PR → `main` (deploy produção). `main` e `homolog` são protegidas: PR obrigatório e check `Testes` verde.
