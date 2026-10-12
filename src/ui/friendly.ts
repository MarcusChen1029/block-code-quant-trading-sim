/**
 * Plain-words versions of the technical messages the page can show. Anything not recognised is returned unchanged,
 * so a real error is never hidden: only well-known families get a kinder text (the original messages stay as they
 * are in the code and its tests).
 */
const NETWORK = /failed to fetch|networkerror|load failed|network request failed|err_internet|err_network|err_tunnel/i;
const SOCKET = /websocket (error|connection)/i;

const THOUSANDS = new Intl.NumberFormat('en-US');

/** [pattern, replacement]: the first pattern found in the message decides; `$1`… are the pattern's groups. */
const REWRITES: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
  [/range too large: \d+ bars \(max (\d+)\)/, (m) => `That is too many candles to load at once (the limit is ${THOUSANDS.format(Number(m[1]))}). Pick a later start date or a bigger candle size.`],
  [/symbol must be 2-20 letters\/digits/, () => 'The coin name should be 2 to 20 letters or numbers, like BTCUSDT.'],
  [/start date must be in the past/, () => 'The start date has to be in the past. Pick an earlier day.'],
  [/start date must be YYYY-MM-DD/, () => 'Please pick a start date (use the little calendar).'],
  [/balance must be greater than 0/, () => 'Starting money has to be more than 0.'],
  [/leverage must be between 1 and 125/, () => 'Leverage has to be a number from 1 to 125. Leave it at 1 if you are unsure.'],
];

export function friendlyMessage(text: string): string {
  if (NETWORK.test(text)) return 'Could not get prices. Check your internet connection and try again. (Binance may also be blocked on your network.)';
  if (SOCKET.test(text)) return 'The live price feed disconnected. It reconnects by itself; the chart keeps what it has.';
  for (const [pattern, rewrite] of REWRITES) {
    const match = pattern.exec(text);
    if (match) return rewrite(match);
  }
  return text;
}
