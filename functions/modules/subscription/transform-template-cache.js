import { getCache } from '../../services/node-cache-service.js';

const TEMPLATE_CACHE_PREFIX = 'transform_template_';

function makeTemplateCacheKey(url) {
    return `${TEMPLATE_CACHE_PREFIX}${btoa(url).replace(/=+$/g, '')}`;
}

/**
 * 判断模板内容是否"看起来是有效模板"。
 * 覆盖三种形式：
 *   1. ACL4SSR / subconverter 风格：含 custom_proxy_group= / ruleset= / [Proxy Group] / [Rule] / [custom]
 *   2. 占位符风格：含 `<%xxx%>` 之类渲染占位符（transform-template-renderer）
 *   3. Clash/YAML 模板：含 proxies: / proxy-groups: / rules:
 * 任一满足即视作有效，用于防止把空内容 / 占位页 / 限流页固化到缓存。
 */
function isProbablyValidTemplate(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    if (/(custom_proxy_group\s*=|ruleset\s*=|\[Proxy Group\]|\[Rule\]|\[custom\])/i.test(trimmed)) return true;
    if (/<%\s*[a-zA-Z_][a-zA-Z0-9_]*\s*%>/.test(trimmed)) return true;
    if (/(^|\n)\s*(proxies\s*:|proxy-groups\s*:|rules\s*:)/i.test(trimmed)) return true;
    return false;
}

export async function fetchTransformTemplate(storageAdapter, templateUrl, forceRefresh = false) {
    if (!templateUrl) return null;

    const cacheKey = makeTemplateCacheKey(templateUrl);
    if (!forceRefresh) {
        const { data } = await getCache(storageAdapter, cacheKey);
        // 只采纳看起来有效的缓存；空内容或明显坏的缓存直接穿透到远端重拉
        if (data?.nodes && isProbablyValidTemplate(data.nodes)) {
            return data.nodes;
        }
    }

    const response = await fetch(templateUrl, {
        headers: {
            'User-Agent': 'MiSub-Template-Fetch/1.0'
        }
    });

    if (!response.ok) {
        throw new Error(`Template fetch failed: HTTP ${response.status}`);
    }

    const text = await response.text();

    // 仅在内容看起来有效时写入缓存，避免把空/占位页固化 24h
    if (isProbablyValidTemplate(text)) {
        const cacheEntry = {
            nodes: text,
            timestamp: Date.now(),
            nodeCount: 0,
            sources: [templateUrl]
        };
        if (storageAdapter?.kv && typeof storageAdapter.kv.put === 'function') {
            await storageAdapter.kv.put(cacheKey, JSON.stringify(cacheEntry), {
                expirationTtl: 24 * 60 * 60
            });
        } else if (storageAdapter && typeof storageAdapter.put === 'function') {
            await storageAdapter.put(cacheKey, cacheEntry);
        }
    } else {
        console.warn(`[Template Cache] Remote template looked invalid (len=${text.length}); not caching. URL=${templateUrl}`);
    }

    return text;
}
