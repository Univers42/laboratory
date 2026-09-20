export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** poll until cond() holds, else throw after ms */
export async function waitFor(cond: () => boolean, ms: number, what = 'condition'): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cond()) return;
    await sleep(60);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

export function httpErr(status: number, text: string) {
  return new Error(`HTTP ${status}${text ? ' ' + text.slice(0, 140).replace(/\s+/g, ' ') : ''}`);
}

/** a 64x64 PNG avatar for a culture, as a Blob */
export function avatarPng(color: string, initial: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0b1220';
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initial, 32, 34);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
