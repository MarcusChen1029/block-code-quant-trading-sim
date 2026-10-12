/**
 * Plain-words versions of the technical messages the page can show. Anything not recognised is returned unchanged,
 * so a real error is never hidden: only the well-known "the internet did not answer" family gets a kinder text.
 */
const NETWORK = /failed to fetch|networkerror|load failed|network request failed|err_internet|err_network|err_tunnel/i;
const SOCKET = /websocket (error|connection)/i;

export function friendlyMessage(text: string): string {
  if (NETWORK.test(text)) return 'Could not get prices. Check your internet connection and try again. (Binance may also be blocked on your network.)';
  if (SOCKET.test(text)) return 'The live price feed disconnected. It reconnects by itself; the chart keeps what it has.';
  return text;
}
