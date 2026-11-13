import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../infrastructure/web/app';
import { Events } from '../domain/messages';
import { gerarOrcamento, makeHarness } from './support/fakes';

const SECRET = 'jwt-test';
const WEBHOOK_SECRET = 'mp-webhook-secret';

const token = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) =>
  jwt.sign(claims, SECRET, { issuer: 'oficina-marimb0ndo-auth', audience: 'oficina-marimb0ndo-api', expiresIn: '1h', ...opts });
const clientToken = token({ sub: 'client-1', type: 'client', status: 'ATIVO' });
const staffToken = token({ sub: 'admin', role: 'ADMIN' }, { issuer: 'oficina-marimb0ndo-os' });

/** Assinatura no formato do Mercado Pago: ts (ms)=..,v1=HMAC_SHA256("id:..;request-id:..;ts:..;") */
function sign(dataId: string, requestId: string, ts = Date.now(), secret = WEBHOOK_SECRET) {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${crypto.createHmac('sha256', secret).update(manifest).digest('hex')}`;
}

async function setup(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const h = makeHarness(() => new Date());
  const quote = await h.billing.generateQuote(gerarOrcamento());
  const app = createApp({ billing: h.billing, jwtSecret: SECRET, webhookSecret: WEBHOOK_SECRET, logger: { warn: jest.fn(), error: jest.fn() }, ...overrides });
  return { ...h, app, quote };
}

describe('HTTP — infraestrutura', () => {
  it('GET /health ok e degradado', async () => {
    const { app } = await setup();
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'ok', service: 'billing-service' });
    const { app: degraded } = await setup({ isReady: () => false });
    expect((await request(degraded).get('/health')).status).toBe(503);
  });

  it('Swagger publicado em /api-docs', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api-docs/');
    expect(res.status).toBe(200);
  });

  it('exige x-origin-verify quando configurado (exceto /health)', async () => {
    const { app } = await setup({ originVerifySecret: 'gw' });
    expect((await request(app).get('/orcamentos?osId=os-1').set('Authorization', `Bearer ${staffToken}`)).status).toBe(403);
    expect((await request(app).get('/orcamentos?osId=os-1').set('Authorization', `Bearer ${staffToken}`).set('x-origin-verify', 'gw')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('JSON inválido → 400; erro inesperado → 500', async () => {
    const { app, billing } = await setup();
    const bad = await request(app).post('/orcamentos/x/recusar').set('Authorization', `Bearer ${clientToken}`).set('Content-Type', 'application/json').send('{x');
    expect(bad.status).toBe(400);
    jest.spyOn(billing, 'listByServiceOrder').mockRejectedValueOnce(new Error('dynamo fora'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get('/orcamentos?osId=os-1').set('Authorization', `Bearer ${staffToken}`)).status).toBe(500);
    spy.mockRestore();
  });
});

describe('HTTP — autenticação', () => {
  it.each([
    ['sem token', undefined],
    ['token malformado', 'Bearer abc'],
    ['audience errada', `Bearer ${token({ sub: 'c', type: 'client', status: 'ATIVO' }, { audience: 'x' })}`],
    ['cliente inativo', `Bearer ${token({ sub: 'c', type: 'client', status: 'BLOQUEADO' })}`],
  ])('401 com %s', async (_label, header) => {
    const { app, quote } = await setup();
    const req = request(app).get(`/orcamentos/${quote.id}`);
    if (header) req.set('Authorization', header);
    expect((await req).status).toBe(401);
  });
});

describe('HTTP — orçamentos', () => {
  it('cliente consulta, aprova e recebe o link do Checkout Pro', async () => {
    const { app, quote, publisher } = await setup();
    const auth = { Authorization: `Bearer ${clientToken}` };

    const got = await request(app).get(`/orcamentos/${quote.id}`).set(auth);
    expect(got.body.data.quote).toMatchObject({ id: quote.id, totalCents: 25000 });

    const list = await request(app).get('/orcamentos?osId=os-1').set(auth);
    expect(list.body.data).toHaveLength(1);
    expect((await request(app).get('/orcamentos').set(auth)).status).toBe(422);

    const approved = await request(app).post(`/orcamentos/${quote.id}/aprovar`).set(auth);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ quoteId: quote.id, status: 'APROVADO', amountCents: 25000 });
    expect(approved.body.data.checkoutUrl).toMatch(/^https:\/\/mp\.test\/checkout\//);
    expect(publisher.last().type).toBe(Events.ORCAMENTO_APROVADO);
  });

  it('cliente recusa o orçamento', async () => {
    const { app, quote, publisher } = await setup();
    const res = await request(app).post(`/orcamentos/${quote.id}/recusar`).set('Authorization', `Bearer ${clientToken}`).send({ reason: 'caro' });
    expect(res.body.data).toEqual({ quoteId: quote.id, status: 'RECUSADO' });
    expect(publisher.last().payload).toMatchObject({ reason: 'caro' });
  });

  it('recusar sem corpo usa motivo padrão', async () => {
    const { app, quote } = await setup();
    const res = await request(app).post(`/orcamentos/${quote.id}/recusar`).set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
  });

  it('outro cliente recebe 403', async () => {
    const { app, quote } = await setup();
    const other = token({ sub: 'client-2', type: 'client', status: 'ATIVO' });
    expect((await request(app).get(`/orcamentos/${quote.id}`).set('Authorization', `Bearer ${other}`)).status).toBe(403);
  });
});

describe('HTTP — webhook do Mercado Pago', () => {
  async function paidSetup() {
    const s = await setup();
    const { payment } = await s.billing.approveQuote(s.quote.id, { sub: 'client-1', type: 'client' });
    s.gateway.pay('123456', payment.id);
    return { ...s, paymentId: payment.id };
  }

  it('assinatura válida processa o pagamento aprovado', async () => {
    const { app, publisher } = await paidSetup();
    const res = await request(app)
      .post('/webhooks/mercadopago?type=payment&data.id=123456')
      .set('x-signature', sign('123456', 'req-1'))
      .set('x-request-id', 'req-1')
      .send({ action: 'payment.updated', type: 'payment', data: { id: '123456' } });
    expect(res.body).toEqual({ status: 'processed', paymentStatus: 'APROVADO' });
    expect(publisher.last().type).toBe(Events.PAGAMENTO_CONFIRMADO);
  });

  it.each([
    ['sem assinatura', undefined],
    ['assinatura com outro segredo', sign('123456', 'req-1', undefined, 'outro')],
    ['timestamp antigo (replay)', sign('123456', 'req-1', Date.now() - 3_600_000)],
  ])('401 com %s', async (_label, signature) => {
    const { app, publisher } = await paidSetup();
    const req = request(app).post('/webhooks/mercadopago?type=payment&data.id=123456').set('x-request-id', 'req-1');
    if (signature) req.set('x-signature', signature);
    expect((await req).status).toBe(401);
    expect(publisher.types()).not.toContain(Events.PAGAMENTO_CONFIRMADO);
  });

  it('ignora notificações de outros tipos', async () => {
    const { app } = await paidSetup();
    const res = await request(app)
      .post('/webhooks/mercadopago?type=merchant_order&data.id=99')
      .set('x-signature', sign('99', 'r'))
      .set('x-request-id', 'r');
    expect(res.body).toEqual({ status: 'ignored', reason: 'tipo merchant_order' });
  });

  it('sem segredo configurado: 503 em produção, aceito em desenvolvimento (id no corpo)', async () => {
    const prod = await setup({ webhookSecret: undefined, allowUnsignedWebhooks: false });
    expect((await request(prod.app).post('/webhooks/mercadopago').send({ type: 'payment', data: { id: '1' } })).status).toBe(503);

    const dev = await setup({ webhookSecret: undefined, allowUnsignedWebhooks: true });
    const { payment } = await dev.billing.approveQuote(dev.quote.id, { sub: 'client-1', type: 'client' });
    dev.gateway.pay('777', payment.id, 'in_process');
    const res = await request(dev.app).post('/webhooks/mercadopago').send({ type: 'payment', data: { id: '777' } });
    expect(res.body).toEqual({ status: 'ignored', paymentStatus: 'in_process' });
    const noType = await request(dev.app).post('/webhooks/mercadopago').send({});
    expect(noType.body.reason).toBe('tipo desconhecido');
  });

  it('erro ao consultar o MP responde 500 para o Mercado Pago tentar de novo', async () => {
    const { app } = await setup({ webhookSecret: undefined, allowUnsignedWebhooks: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/webhooks/mercadopago?topic=payment&id=nao-existe');
    spy.mockRestore();
    expect(res.status).toBe(500);
  });
});
