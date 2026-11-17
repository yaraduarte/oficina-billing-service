export interface JobLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Executa uma tarefa em intervalo fixo, sem sobrepor execuções e sem derrubar o processo
 * se a tarefa falhar (usado pela reconciliação de pagamentos com o Mercado Pago).
 */
export class PeriodicJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly task: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly logger: JobLogger = console,
  ) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.task();
    } catch (err) {
      this.logger.warn(`[${this.name}] Falha na execução`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
