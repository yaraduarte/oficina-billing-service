import { loadConfig } from './config';
import { bootstrap } from './bootstrap';

const config = loadConfig();

bootstrap(config)
  .then(({ app, stop }) => {
    const server = app.listen(config.port, () => {
      console.log(`[Server] billing-service na porta ${config.port} — Swagger em /api-docs`);
    });
    const shutdown = () => {
      server.close();
      stop().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('[Server] Falha ao iniciar o billing-service', err);
    process.exit(1);
  });
