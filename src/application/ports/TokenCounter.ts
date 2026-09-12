/**
 * TokenCounter Port
 * Measures token usage for budget packing and chunking constraints.
 */

export interface TokenCounter {
  readonly tokenizerId: string;
  count(text: string): number;
}
