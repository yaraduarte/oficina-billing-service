import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Quote, QuoteStatus } from '../../domain/Quote';
import { Payment, PaymentStatus } from '../../domain/Payment';
import { IPaymentRepository, IQuoteRepository } from '../../application/ports';

export const QUOTES_OS_INDEX = 'osId-index';
export const PAYMENTS_QUOTE_INDEX = 'quoteId-index';

/** Cliente mínimo usado pelos repositórios (facilita testes). */
export type DocClient = Pick<DynamoDBDocumentClient, 'send'>;

function isConditionalFailure(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException || (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** Put condicional: cria só se não existir, ou grava só se o status atual estiver na lista. */
async function conditionalPut(
  client: DocClient,
  table: string,
  item: Record<string, unknown>,
  expectedStatuses?: string[],
): Promise<boolean> {
  const condition = expectedStatuses
    ? {
        ConditionExpression: `#status IN (${expectedStatuses.map((_, i) => `:s${i}`).join(', ')})`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: Object.fromEntries(expectedStatuses.map((s, i) => [`:s${i}`, s])),
      }
    : { ConditionExpression: 'attribute_not_exists(id)' };
  try {
    await client.send(new PutCommand({ TableName: table, Item: item, ...condition }));
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

export class DynamoQuoteRepository implements IQuoteRepository {
  constructor(
    private readonly client: DocClient,
    private readonly table: string,
  ) {}

  async findById(id: string) {
    const res = await this.client.send(new GetCommand({ TableName: this.table, Key: { id } }));
    return res.Item ? new Quote(res.Item as Quote) : null;
  }

  async findByOsId(osId: string) {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: QUOTES_OS_INDEX,
        KeyConditionExpression: 'osId = :osId',
        ExpressionAttributeValues: { ':osId': osId },
      }),
    );
    return (res.Items ?? []).map((i) => new Quote(i as Quote));
  }

  async findBySagaId(sagaId: string, osId: string) {
    return (await this.findByOsId(osId)).find((q) => q.sagaId === sagaId) ?? null;
  }

  create(quote: Quote) {
    return conditionalPut(this.client, this.table, { ...quote });
  }

  saveIfStatus(quote: Quote, expected: QuoteStatus[]) {
    return conditionalPut(this.client, this.table, { ...quote }, expected);
  }
}

export class DynamoPaymentRepository implements IPaymentRepository {
  constructor(
    private readonly client: DocClient,
    private readonly table: string,
  ) {}

  async findById(id: string) {
    const res = await this.client.send(new GetCommand({ TableName: this.table, Key: { id } }));
    return res.Item ? new Payment(res.Item as Payment) : null;
  }

  async findByQuoteId(quoteId: string) {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: PAYMENTS_QUOTE_INDEX,
        KeyConditionExpression: 'quoteId = :q',
        ExpressionAttributeValues: { ':q': quoteId },
        Limit: 1,
      }),
    );
    const item = res.Items?.[0];
    return item ? new Payment(item as Payment) : null;
  }

  create(payment: Payment) {
    return conditionalPut(this.client, this.table, { ...payment });
  }

  saveIfStatus(payment: Payment, expected: PaymentStatus[]) {
    return conditionalPut(this.client, this.table, { ...payment }, expected);
  }
}
