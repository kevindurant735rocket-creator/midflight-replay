/**
 * Default-on secret redaction. Runs before anything reaches the report.
 * Contract: no pattern may depend on a hardcoded username; the home dir is passed in.
 */

export interface RedactOptions {
  /** absolute home directory to collapse, e.g. /Users/alice */
  homeDir?: string;
  /** collapse /Users/<name> style paths even when homeDir is unknown */
  maskUserPaths?: boolean;
  /** max secrets shown in the "redaction summary" (kept as a count, never the value) */
  enabled?: boolean;
}

export interface RedactResult {
  text: string;
  /** number of substitutions applied */
  count: number;
  /** distinct rule names that fired, sorted */
  rules: string[];
}

type Rule = { name: string; re: RegExp; replace: (m: RegExpExecArray) => string };

const SECRET_RULES: Rule[] = [
  { name: 'openai-key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, replace: () => '[REDACTED:openai-key]' },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: () => '[REDACTED:anthropic-key]' },
  { name: 'github-pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: () => '[REDACTED:github-pat]' },
  { name: 'github-pat-2', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => '[REDACTED:github-pat]' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: () => '[REDACTED:slack-token]' },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws-key]' },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => '[REDACTED:google-key]' },
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, replace: () => '[REDACTED:private-key]' },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replace: () => 'Bearer [REDACTED:token]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => '[REDACTED:jwt]' },
  {
    name: 'kv-assignment',
    re: /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^\s"'&,;}]{8,})/gi,
    replace: (m) => `${m[1] ?? ''}[REDACTED:kv]`,
  },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: () => '[REDACTED:email]' },
];

export const REDACT_RULE_NAMES = SECRET_RULES.map((r) => r.name);

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  if (opts.enabled === false) return { text: input, count: 0, rules: [] };
  let text = input;
  const fired = new Set<string>();
  let count = 0;
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      count += 1;
      fired.add(rule.name);
      return rule.replace(m);
    });
  }
  if (opts.homeDir && opts.homeDir.length > 2) {
    const esc = opts.homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc, 'g');
    if (re.test(text)) {
      fired.add('home-dir');
      text = text.replace(re, '/HOME');
    }
  }
  if (opts.maskUserPaths !== false) {
    const re = /(\/(?:Users|home)\/)[^/\s"'`:]+/g;
    if (re.test(text)) {
      fired.add('user-path');
      text = text.replace(re, '$1USER');
    }
  }
  return { text, count, rules: [...fired].sort() };
}
