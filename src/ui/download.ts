/** Starts a browser download of `blob` under `name` (the file goes to the user's Downloads folder). */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(name: string, text: string, mime: string): void {
  // A byte-order mark makes spreadsheets read CSV as UTF-8.
  downloadBlob(name, new Blob([mime.startsWith('text/csv') ? '﻿' : '', text], { type: `${mime};charset=utf-8` }));
}
