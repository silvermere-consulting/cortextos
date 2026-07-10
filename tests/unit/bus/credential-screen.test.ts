import { describe, it, expect } from 'vitest';
import { hasCredential, looksLikeSecretValue, isUnscreenableBinary } from '../../../src/bus/system.js';
import zlib from 'zlib';

/**
 * Regression gate for the auto-commit credential screen.
 *
 * Every value here is SYNTHETIC. Never put a real credential in a fixture — the
 * commit that taught this screen to block apr1 hashes used a real apr1 hash as
 * its fixture, and the fixture outlived the lesson.
 *
 * The corpus is not invented. It is the set of strings the old screen got wrong,
 * measured 2026-07-10 against the live binary:
 *   - `BOT_TOKEN=<token>` passed, because `\b` cannot fire between `_` and `T`.
 *   - A bare `digits:35` Telegram token passed; no shape covered it.
 *   - `github_pat_` passed; only classic `ghp_` was listed.
 *   - `token: string` BLOCKED, and ate memory/phase2-diffs/8719612.patch — a
 *     TypeScript lexer diff — silently, for three weeks, under a "committed" badge.
 */
describe('credential screen: shapes that MUST block', () => {
  const FAKE_TG = `1234567890:${'AAH' + 'q'.repeat(20) + 'Zz9' + 'k'.repeat(9)}`;

  it.each([
    ['bare Telegram token', `see ${FAKE_TG} here`],
    ['BOT_TOKEN= (the \\b defect)', `BOT_TOKEN=${FAKE_TG}`],
    ['any identifier prefix', 'xxxpassword=abc123def456'],
    ['github fine-grained PAT', 'github_pat_' + 'A'.repeat(30)],
    ['github classic PAT', 'ghp_' + 'B'.repeat(24)],
    ['apr1 htpasswd hash', '$apr1$abcd1234$' + 'x'.repeat(22)],
    ['bcrypt hash', '$2y$10$' + 'c'.repeat(53)],
    ['plain assignment', 'token=abc123def456'],
    ['quoted assignment', 'password: "abc123def456"'],
    ['JWT (dotted — must not hit the path exemption)',
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ])('blocks %s', (_label, content) => {
    expect(hasCredential(content)).toBe(true);
  });
});

describe('credential screen: PROSE and SOURCE CODE that MUST stage', () => {
  it.each([
    // Prose about secrets — the incident record must stay committable.
    ['prose: token = single', 'The bot token = single point of failure; rotation is non-negotiable.'],
    ['prose: token: REVOKED', 'Status of the token: REVOKED as of this morning.'],
    ['prose: secret = permanent', 'Treat the secret = permanent once it enters git history.'],
    ['sql prose', 'UPDATE users SET password=NULL;'],
    ['redaction marker stays committable', '$apr1$<REDACTED>'],

    // Source code — the 8719612.patch class. A tokeniser has tokens in it.
    ['type annotation', 'interface T { token: string; }'],
    ['identifier assignment', 'const token = parsedToken;'],
    ['property access', 'const secret = crypto.randomBytes(32)'],
    ['env reference', 'api_key: process.env.OPENAI_API_KEY'],
    ['long camelCase, no digit', 'const token = authorizationHeaderValue'],

    // References and placeholders are never literals.
    ['shell interpolation', 'GEMINI_API_KEY="${GEMINI_API_KEY:-}"'],
    ['interpolation carrying a digit', 'password="${SECRET_2024}"'],
    ['angle placeholder carrying a digit', 'token=<TOKEN_2024>'],
    ['quoted placeholder, no digit', 'COACH_PASSWORD="dev-only" is a placeholder'],
  ])('stages %s', (_label, content) => {
    expect(hasCredential(content)).toBe(false);
  });
});

describe('looksLikeSecretValue: stated limitations, asserted so they cannot drift silently', () => {
  // These are deliberate false negatives. Widening to catch them re-blocks the
  // source code and the prose, which is the bug this patch exists to fix. Every
  // credential the fleet actually handles is caught by a SHAPE rule instead.
  it('stages a short all-alphabetic secret', () => {
    expect(looksLikeSecretValue('changeme')).toBe(false);
  });
  it('stages a long all-alphabetic secret', () => {
    expect(looksLikeSecretValue('correcthorsebatterystaple')).toBe(false);
  });
  it('blocks the same value once it carries a digit', () => {
    expect(looksLikeSecretValue('abc123def456')).toBe(true);
  });
  it('keeps the pre-existing {6,} floor: token=abc123 must still block', () => {
    expect(looksLikeSecretValue('abc123')).toBe(true);
  });
  it('stages the alpha-only identifiers the old screen ate', () => {
    for (const v of ['string', 'parsed', 'process', 'single', 'REVOKED', 'permanent']) {
      expect(looksLikeSecretValue(v)).toBe(false);
    }
  });
  it('stages references regardless of digits', () => {
    expect(looksLikeSecretValue('process.env.KEY2')).toBe(false);
    expect(looksLikeSecretValue('${SECRET_2024}')).toBe(false);
  });
  // ACCEPTED FALSE POSITIVE, asserted so it is visible rather than discovered.
  // `sha256Hash` is indistinguishable by content from `abc123`, which this repo
  // has always required to block. Documented in looksLikeSecretValue().
  it('blocks a digit-bearing identifier (known false positive)', () => {
    expect(looksLikeSecretValue('sha256Hash')).toBe(true);
  });
});

/**
 * NAMED FALSE-NEGATIVE CLASS — human-chosen alphabetic passphrases.
 *
 * The digit rule is sound against the threat that actually bit us: every
 * MACHINE-generated credential we handle (ghp_, github_pat_, sk-, AIza, AKIA,
 * xoxb-, a bare Telegram token, a JWT, bcrypt, apr1) carries digits BY
 * CONSTRUCTION and is caught by its own shape rule regardless. A human passphrase
 * carries none and sails through — and a human typing a password into a script at
 * 2am is exactly the case that screening scripts was meant to cover.
 *
 * These tests ASSERT the gap rather than close it. Closing it needs another
 * pattern, and every pattern added tonight to catch a word ended up eating source
 * code. A finding in a test executes; a finding in a comment dies.
 *
 * READ THIS BEFORE TRUSTING THE ACCEPTANCE CORPUS. The 8-stage/4-block corpus that
 * validated this screen was labelled "value-bearing = letters AND digits" — the
 * same heuristic under test here. It therefore proves "these files contain no
 * machine-generated-LOOKING value", NOT "these files contain no secret". Three
 * reviewers independently reached for that instrument and all three inherited its
 * blind spot. A gate whose corpus was labelled by a weakened form of the rule it
 * validates is CIRCULAR, and it will read green forever.
 */
describe('KNOWN FALSE NEGATIVES: alphabetic human passphrases stage', () => {
  it.each([
    ['multiword passphrase', 'password=correcthorsebattery'],
    ['capitalised passphrase', 'password=ThisIsMyLongPassword'],
    ['short alphabetic secret', 'password=letmein'],
    ['quoted alphabetic secret', 'password: "changeme"'],
  ])('stages %s — by design, until a rule exists that spares source code', (_l, content) => {
    expect(hasCredential(content)).toBe(false);
  });

  it('but one digit anywhere in the passphrase catches it', () => {
    expect(hasCredential('password=correcthorsebattery1')).toBe(true);
    expect(hasCredential('password=ThisIsMyLongPassw0rd')).toBe(true);
  });
});

describe('isUnscreenableBinary: classify by decodability, never by extension', () => {
  it('treats a cleartext PDF as screenable (the regexes really do read it)', () => {
    expect(isUnscreenableBinary(Buffer.from('%PDF-1.4\npassword=abc123def456\n%%EOF\n'))).toBe(false);
  });
  it('treats a compressed PDF as unscreenable', () => {
    const buf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      zlib.deflateSync(Buffer.from('password=abc123def456')),
      Buffer.from('\n%%EOF\n'),
    ]);
    expect(isUnscreenableBinary(buf)).toBe(true);
  });
  it('treats any NUL-bearing file as unscreenable', () => {
    expect(isUnscreenableBinary(Buffer.from('tEXt\0password=abc123def456'))).toBe(true);
  });
  it('does NOT mistake valid UTF-8 (emoji, CJK, dashes) for binary', () => {
    expect(isUnscreenableBinary(Buffer.from('# notes — café ✅ 日本語\n', 'utf-8'))).toBe(false);
  });
  it('does not choke on an empty file', () => {
    expect(isUnscreenableBinary(Buffer.alloc(0))).toBe(false);
  });
});
