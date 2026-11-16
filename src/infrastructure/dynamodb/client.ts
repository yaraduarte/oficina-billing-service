import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PAYMENTS_QUOTE_INDEX, QUOTES_OS_INDEX } from './DynamoRepositories';

export interface DynamoSettings {
  region: string;
  /** Endpoint do DynamoDB Local (dev/docker-compose). Vazio = AWS. */
  endpoint?: string;
}

export function createDynamoClients(settings: DynamoSettings) {
  const raw = new DynamoDBClient({
    region: settings.region,
    ...(settings.endpoint
      ? { endpoint: settings.endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  return { raw, doc };
}

/** Definição das tabelas — espelhada no Terraform (oficina-infra-db). */
export function tableDefinitions(quotesTable: string, paymentsTable: string) {
  return [
    {
      TableName: quotesTable,
      BillingMode: 'PAY_PER_REQUEST' as const,
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' as const },
        { AttributeName: 'osId', AttributeType: 'S' as const },
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
      GlobalSecondaryIndexes: [
        { IndexName: QUOTES_OS_INDEX, KeySchema: [{ AttributeName: 'osId', KeyType: 'HASH' as const }], Projection: { ProjectionType: 'ALL' as const } },
      ],
    },
    {
      TableName: paymentsTable,
      BillingMode: 'PAY_PER_REQUEST' as const,
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' as const },
        { AttributeName: 'quoteId', AttributeType: 'S' as const },
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
      GlobalSecondaryIndexes: [
        { IndexName: PAYMENTS_QUOTE_INDEX, KeySchema: [{ AttributeName: 'quoteId', KeyType: 'HASH' as const }], Projection: { ProjectionType: 'ALL' as const } },
      ],
    },
  ];
}

/** Cria as tabelas se não existirem (apenas DynamoDB Local / dev). */
export async function ensureTables(raw: Pick<DynamoDBClient, 'send'>, quotesTable: string, paymentsTable: string): Promise<void> {
  for (const def of tableDefinitions(quotesTable, paymentsTable)) {
    try {
      await raw.send(new CreateTableCommand(def));
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (!(err instanceof ResourceInUseException) && name !== 'ResourceInUseException') throw err;
    }
  }
}
