import { describe, it, expect } from 'vitest';
import { parseRuleSetLines } from '../../functions/modules/subscription/rule-set-fetcher.js';

describe('parseRuleSetLines', () => {
    it('parses ACL4SSR-style text .list (每行 TYPE,VALUE)', () => {
        const text = `
# 这是注释
; 另一种注释
DOMAIN-SUFFIX,google.com
DOMAIN-KEYWORD,google
IP-CIDR,8.8.8.8/32,no-resolve
`;
        const result = parseRuleSetLines(text);
        expect(result).toEqual([
            'DOMAIN-SUFFIX,google.com',
            'DOMAIN-KEYWORD,google',
            'IP-CIDR,8.8.8.8/32,no-resolve'
        ]);
    });

    it('parses YAML-style classical with payload:', () => {
        const text = `payload:
  - 'DOMAIN-SUFFIX,youtube.com'
  - "DOMAIN-KEYWORD,google"
  - IP-CIDR,1.1.1.1/32
`;
        const result = parseRuleSetLines(text);
        expect(result).toEqual([
            'DOMAIN-SUFFIX,youtube.com',
            'DOMAIN-KEYWORD,google',
            'IP-CIDR,1.1.1.1/32'
        ]);
    });

    it('ignores lines without commas (not a real rule)', () => {
        const text = `random garbage line\nDOMAIN-SUFFIX,x.com`;
        const result = parseRuleSetLines(text);
        expect(result).toEqual(['DOMAIN-SUFFIX,x.com']);
    });

    it('returns empty list for non-string / empty input', () => {
        expect(parseRuleSetLines(null)).toEqual([]);
        expect(parseRuleSetLines('')).toEqual([]);
        expect(parseRuleSetLines('   \n\n\n')).toEqual([]);
    });
});
