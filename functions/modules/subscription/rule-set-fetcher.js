import { getCache } from '../../services/node-cache-service.js';

const RULE_SET_CACHE_PREFIX = 'rule_set_';
const RULE_SET_CACHE_TTL = 24 * 60 * 60; // 24h

function makeKey(url) {
    return `${RULE_SET_CACHE_PREFIX}${btoa(url).replace(/=+$/g, '')}`;
}

/**
 * 拉取单个 rule-set 文件（.list / .yaml），带 24 小时 KV 缓存。
 * 拉取失败或内容为空时返回 null，调用方需自行容错（通常降级为 RULE-SET 引用）。
 */
export async function fetchRuleSetText(storageAdapter, url, forceRefresh = false) {
    if (!url || !/^https?:\/\//i.test(url)) return null;

    const cacheKey = makeKey(url);
    if (!forceRefresh) {
        try {
            const { data } = await getCache(storageAdapter, cacheKey);
            if (data?.text && typeof data.text === 'string' && data.text.trim().length > 0) {
                return data.text;
            }
        } catch (e) { /* 缓存读取失败忽略，走远端 */ }
    }

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'MiSub-RuleSet-Fetch/1.0' }
        });
        if (!response.ok) {
            console.warn(`[RuleSet] HTTP ${response.status} for ${url}`);
            return null;
        }
        const text = await response.text();
        if (!text || text.trim().length === 0) {
            console.warn(`[RuleSet] Empty body for ${url}`);
            return null;
        }

        const entry = { text, timestamp: Date.now() };
        if (storageAdapter?.kv && typeof storageAdapter.kv.put === 'function') {
            await storageAdapter.kv.put(cacheKey, JSON.stringify(entry), { expirationTtl: RULE_SET_CACHE_TTL });
        } else if (storageAdapter && typeof storageAdapter.put === 'function') {
            await storageAdapter.put(cacheKey, entry);
        }

        return text;
    } catch (e) {
        console.warn(`[RuleSet] Fetch error ${url}:`, e?.message || e);
        return null;
    }
}

/**
 * 批量抓取多个 rule-set，返回 Map<url, text>。
 * 并发拉取但限制并发上限，避免瞬时 40+ 连接把 Cloudflare Workers 打爆。
 */
export async function fetchRuleSetBatch(storageAdapter, urls, forceRefresh = false) {
    const unique = [...new Set((urls || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))];
    const result = new Map();
    if (unique.length === 0) return result;

    const CONCURRENCY = 8;
    let idx = 0;
    async function worker() {
        while (idx < unique.length) {
            const current = idx++;
            const url = unique[current];
            const text = await fetchRuleSetText(storageAdapter, url, forceRefresh);
            if (text) result.set(url, text);
        }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker());
    await Promise.all(workers);
    return result;
}

/**
 * 把一个 rule-set 文本解析为"已清洗"的规则行列表（不含 policy 和换行）。
 * 支持两种常见格式：
 *   1. Classical text（ACL4SSR / subconverter 默认）：每行 `DOMAIN-SUFFIX,x.com` 或带修饰 `,no-resolve`
 *   2. YAML classical（以 `payload:` 开头、每项 `- 'DOMAIN-SUFFIX,...'`）
 * 会自动剥掉注释 / 空行 / 引号 / 列表前导 `- `。
 */
export function parseRuleSetLines(text) {
    if (typeof text !== 'string' || !text) return [];
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
        // 跳过 YAML 首行的 "payload:" 标识
        if (/^payload\s*:\s*$/i.test(line)) continue;
        // 去掉 YAML 列表前导 "- "
        if (line.startsWith('- ')) line = line.slice(2).trim();
        // 去掉两侧引号（YAML 里可能是 'DOMAIN-SUFFIX,x.com' 或 "DOMAIN-SUFFIX,x.com"）
        if ((line.startsWith("'") && line.endsWith("'")) || (line.startsWith('"') && line.endsWith('"'))) {
            line = line.slice(1, -1);
        }
        if (!line) continue;
        // 一条规则至少包含一个逗号（TYPE,VALUE 至少两段）
        if (!line.includes(',')) continue;
        out.push(line);
    }
    return out;
}
