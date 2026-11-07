export class FallbackTracker {
  private history: boolean[] = []; // true = fallback, false = model success
  private windowSize: number;
  private maxRate: number;

  constructor(windowSize = 200, maxRate = 0.05) {
    this.windowSize = windowSize;
    this.maxRate = maxRate;
  }

  record(isFallback: boolean): void {
    this.history.push(isFallback);
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }
    this.checkAbort();
  }

  getRate(): number {
    if (this.history.length === 0) return 0;
    const fallbacks = this.history.filter(Boolean).length;
    return fallbacks / this.history.length;
  }

  checkAbort(): void {
    if (this.history.length < 20) return; // Allow a small warm-up before aborting
    const rate = this.getRate();
    if (rate > this.maxRate) {
      const percentage = (rate * 100).toFixed(1);
      throw new Error(
        `Fallback rate (${percentage}%) exceeded maximum allowed rate (${this.maxRate * 100}%) in rolling window of ${this.history.length} entries.`,
      );
    }
  }
}
