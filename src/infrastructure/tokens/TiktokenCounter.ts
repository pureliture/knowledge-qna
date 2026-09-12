/**
 * TiktokenCounter
 * Infrastructure implementation of TokenCounter port using js-tiktoken (cl100k_base).
 */

import { getEncoding } from 'js-tiktoken';
import type { TokenCounter } from '../../application/ports/TokenCounter.js';

export class TiktokenCounter implements TokenCounter {
  readonly tokenizerId = 'cl100k_base';
  private readonly encoder = getEncoding('cl100k_base');

  count(text: string): number {
    if (!text) return 0;
    return this.encoder.encode(text).length;
  }
}
