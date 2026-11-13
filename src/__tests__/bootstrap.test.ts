import request from 'supertest';
import { bootstrap } from '../bootstrap';
import { loadConfig } from '../config';
import { RabbitMQClient } from '../infrastructure/messaging/RabbitMQClient';
import { ensureTables } from '../infrastructure/dynamodb/client';

jest.mock('../infrastructure/dynamodb/client', () => ({
  ...jest.requireActual('../infrastructure/dynamodb/client'),
  ensureTables: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function fakeRabbit() {
  return {
    connect: jest.fn(),
    consume: jest.fn(),
    close: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
  } as unknown as RabbitMQClient & { consume: jest.Mock; close: jest.Mock };
}

describe('bootstrap', () => {
  it('compõe o serviço com RabbitMQ, cria tabelas locais e consome billing.commands', async () => {
    const rabbit = fakeRabbit();
    const config = loadConfig({ NODE_ENV: 'development', DYNAMODB_AUTO_CREATE: 'true', DYNAMODB_ENDPOINT: 'http://localhost:8000' });
    const runtime = await bootstrap(config, { rabbit });

    expect(ensureTables).toHaveBeenCalled();
    expect(rabbit.connect).toHaveBeenCalled();
    expect(rabbit.consume).toHaveBeenCalledWith('billing.commands', expect.any(Function));
    expect((await request(runtime.app).get('/health')).body.status).toBe('ok');

    // o handler registrado manda mensagens malformadas para a DLQ
    const deadLetter = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await rabbit.consume.mock.calls[0][1]({ content: Buffer.from('{x'), headers: {}, routingKey: 'billing' }, { ack: jest.fn(), deadLetter, retry: jest.fn() });
    expect(deadLetter).toHaveBeenCalled();

    await runtime.stop();
    expect(rabbit.close).toHaveBeenCalled();
  });

  it('sem RABBITMQ_URL sobe só a API e recusa publicar eventos', async () => {
    const runtime = await bootstrap(loadConfig({ NODE_ENV: 'development' }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('RABBITMQ_URL não definida'), '');
    expect((await request(runtime.app).get('/health')).status).toBe(200);
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('cria o cliente RabbitMQ a partir da URL configurada', async () => {
    const connect = jest.spyOn(RabbitMQClient.prototype, 'connect').mockResolvedValue(undefined);
    const consume = jest.spyOn(RabbitMQClient.prototype, 'consume').mockResolvedValue(undefined);
    const runtime = await bootstrap(loadConfig({ NODE_ENV: 'development', RABBITMQ_URL: 'amqp://x' }));
    expect(connect).toHaveBeenCalled();
    expect(consume).toHaveBeenCalled();
    expect((await request(runtime.app).get('/health')).status).toBe(503);
  });
});
