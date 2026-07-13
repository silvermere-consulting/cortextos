/**
 * Message-text resolution for bus send commands.
 *
 * WHY (2026-07-13, task_1783951648376): agents compose shell commands like
 *   cortextos bus send-message chief normal '<reply text>'
 * and any apostrophe in the reply (Hiba's, wasn't, don't) terminates the
 * single-quoted arg — three agents hit this in one day. Double quotes are no
 * safer: backticks and $() inside them command-substitute (guardrail 129).
 * Quoting rules are a read-time advisory; the failure happens at typing time.
 *
 * The structural fix is a text path that never transits shell quoting:
 *   --stdin      read the message from stdin (heredoc with a quoted
 *                delimiter: no interpolation, no quote parsing at all)
 *   --text-file  read the message from a file
 * Both accept apostrophes, quotes, backticks, $ and real newlines verbatim.
 */

import { readFileSync } from 'fs';

export interface MessageTextOptions {
  stdin?: boolean;
  textFile?: string;
}

/**
 * Resolve the message text from exactly one source: the positional argument,
 * --text-file, or --stdin. Throws (with a user-facing message) when the
 * sources conflict, are absent, or resolve to an empty message.
 *
 * A single trailing newline is trimmed: heredocs and files virtually always
 * end with one, and it is never intended as message content.
 *
 * `readStdin` is injectable for tests; the default reads fd 0 synchronously.
 */
export function resolveMessageText(
  positional: string | undefined,
  opts: MessageTextOptions,
  readStdin: () => string = () => readFileSync(0, 'utf-8'),
): string {
  if (opts.stdin && opts.textFile) {
    throw new Error('Use either --stdin or --text-file, not both.');
  }

  let text: string;
  if (opts.stdin) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--stdin given but nothing is piped. Pipe the message or use a heredoc:\n' +
        "  cortextos bus send-message <to> <priority> --stdin << 'EOF'\n  <message>\n  EOF",
      );
    }
    text = readStdin();
  } else if (opts.textFile) {
    text = readFileSync(opts.textFile, 'utf-8');
  } else if (positional !== undefined) {
    return positional; // argv text passes through verbatim (no trim)
  } else {
    throw new Error(
      'No message text: pass it as an argument, or use --stdin / --text-file ' +
      '(recommended when the text contains apostrophes, quotes or backticks).',
    );
  }

  text = text.replace(/\n$/, '');
  if (text.trim() === '') {
    throw new Error(`Message text from ${opts.stdin ? 'stdin' : opts.textFile} is empty.`);
  }
  return text;
}
