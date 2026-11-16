'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'Oficina Marimbondo Billing'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: 'info',
    filepath: 'stdout',
  },
  allow_all_headers: true,
  distributed_tracing: {
    enabled: true,
  },
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 100,
  },
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },
  application_logging: {
    enabled: true,
    forwarding: {
      enabled: true,
    },
    local_decorating: {
      enabled: true,
    },
  },
};
