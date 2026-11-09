# oficina-billing-service

**Billing Service** da Oficina Marimb0ndo (FIAP SOAT — Tech Challenge Fase 4).

Orçamentos, aprovação e pagamentos (Mercado Pago) com DynamoDB.

Arquitetura geral, contratos de eventos e decisões: [oficinaMarimbondo/docs/fase4](https://github.com/yaraduarte/oficinaMarimbondo/tree/homolog/docs/fase4).

## Fluxo de branches

`feature/*` → PR → `homolog` (deploy homologação) → PR → `main` (deploy produção). `main` e `homolog` são protegidas.
