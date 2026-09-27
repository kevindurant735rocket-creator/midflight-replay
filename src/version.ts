import { readFileSync } from 'node:fs';

/**
 * The version we print must be the one npm shipped, read from the package.json
 * that sits next to dist/. Returns 'unknown' instead of throwing so a repacked
 * or hand-run checkout degrades to a useless-but-working `--version`.
 */
export function readVersion(pkgUrl: URL = new URL('../package.json', import.meta.url)): string {
  try {
    const v = JSON.parse(readFileSync(pkgUrl, 'utf8')).version;
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}
