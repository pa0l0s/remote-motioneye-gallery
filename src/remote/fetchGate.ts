export interface FetchGateOptions {
  concurrency: number;
  maxRetries: number;
  baseDelayMs: number;
}

export class FetchGate {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly opts: FetchGateOptions) {}

  private async acquire(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      let attempt = 0;
      for (;;) {
        try {
          return await fn();
        } catch (err) {
          if (attempt >= this.opts.maxRetries) throw err;
          const delay = this.opts.baseDelayMs * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
        }
      }
    } finally {
      this.release();
    }
  }
}
