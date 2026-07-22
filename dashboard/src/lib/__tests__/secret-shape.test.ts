import { describe, it, expect } from 'vitest';
import { classifyResponse } from '../secret-shape';

describe('classifyResponse — both directions per vector class', () => {
  // Known-negative fixtures: the intended shapes must pass silently.
  it('passes a one-time share link (the happy path)', () => {
    expect(
      classifyResponse('https://send.example.com/otp/9f8a2c#key').secretShaped,
    ).toBe(false);
  });

  it('passes plain prose', () => {
    expect(
      classifyResponse('Rotated both PATs, links sent separately.').secretShaped,
    ).toBe(false);
  });

  it('passes an empty/whitespace value', () => {
    expect(classifyResponse('   ').secretShaped).toBe(false);
  });

  it('passes a URL containing a long token (share-service design, not a raw secret)', () => {
    expect(
      classifyResponse(
        'https://onetimesecret.com/secret/AbCdEf1234567890AbCdEf1234567890',
      ).secretShaped,
    ).toBe(false);
  });

  // Known-positive fixtures: secret shapes must be refused.
  it('refuses a GitHub classic PAT prefix', () => {
    const v = classifyResponse('ghp_AbCdEf1234567890AbCdEf1234567890AbCd');
    expect(v.secretShaped).toBe(true);
    expect(v.reason).toBe('known credential prefix');
  });

  it('refuses a fine-grained GitHub PAT prefix', () => {
    expect(
      classifyResponse('github_pat_11ABCDEFG0abcdefghijklmnop').secretShaped,
    ).toBe(true);
  });

  it('refuses an sk- API key embedded in prose', () => {
    expect(
      classifyResponse('here you go: sk-abc123def456ghi789jkl012').secretShaped,
    ).toBe(true);
  });

  it('refuses an AWS access key id', () => {
    expect(classifyResponse('AKIAIOSFODNN7EXAMPLE').secretShaped).toBe(true);
  });

  it('refuses a bare high-entropy mixed-class token', () => {
    const v = classifyResponse('q7Zp3vXk9Lm2Rt8Wn4Yb6Jd1Fg5Hs0Ka');
    expect(v.secretShaped).toBe(true);
    expect(v.reason).toBe('high-entropy token');
  });

  it('refuses a JWT', () => {
    expect(
      classifyResponse(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig',
      ).secretShaped,
    ).toBe(true);
  });

  // Boundary: a long single-class run (e.g. a hex hash in prose) is not
  // mixed-class... but lowercase hex mixes letters+digits, which IS 2 classes.
  // The deliberate bias is fail-closed: hashes pasted raw get refused too,
  // which is acceptable — results should be links or prose, not bare blobs.
  it('refuses a bare 40-char hex blob (deliberate fail-closed bias)', () => {
    expect(
      classifyResponse('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3').secretShaped,
    ).toBe(true);
  });
});
