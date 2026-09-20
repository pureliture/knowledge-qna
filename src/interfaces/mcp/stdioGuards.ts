/**
 * Stdio Transport Guards
 * Prevents non-JSON-RPC text from polluting process.stdout in Stdio MCP mode.
 */

export function setupStdioGuards(): void {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  // Divert all standard console outputs to stderr
  console.log = (...args: unknown[]) => {
    originalStderrWrite(`[stdout-diverted-log] ${args.map(String).join(' ')}\n`);
  };
  console.info = (...args: unknown[]) => {
    originalStderrWrite(`[stdout-diverted-info] ${args.map(String).join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    originalStderrWrite(`[stdout-diverted-warn] ${args.map(String).join(' ')}\n`);
  };
  console.debug = (...args: unknown[]) => {
    originalStderrWrite(`[stdout-diverted-debug] ${args.map(String).join(' ')}\n`);
  };
}
