import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTransformTemplate } from '../../functions/modules/subscription/transform-template-cache.js';

describe('Transform template cache', () => {
    const storage = {
        put: vi.fn(),
        get: vi.fn().mockResolvedValue(null)
    };

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('proxies: <%proxies%>\nrules: <%rules%>\n', { status: 200 })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('should fetch and cache template text', async () => {
        const result = await fetchTransformTemplate(storage, 'https://example.com/template.yaml', true);

        expect(result).toContain('proxies: <%proxies%>');
        expect(storage.put).toHaveBeenCalled();
    });

    it('should NOT cache empty or obviously invalid remote template content', async () => {
        // 模拟远端返回空白（CF 占位页 / GitHub 限流 / 未知错误等），不应把坏数据写入缓存
        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('   \n\n', { status: 200 })));

        const result = await fetchTransformTemplate(storage, 'https://example.com/bad.ini', true);

        expect(result).toBe('   \n\n');
        expect(storage.put).not.toHaveBeenCalled();
    });

    it('should NOT return stale cached garbage; re-fetches when cache looks invalid', async () => {
        const badCacheStore = {
            put: vi.fn(),
            // get 返回的缓存内容是明显无效（仅注释/空白），应被忽略
            get: vi.fn().mockResolvedValue({
                nodes: '; no real rules\n\n',
                timestamp: Date.now(),
                nodeCount: 0,
                sources: ['https://example.com/bad.ini']
            })
        };
        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('[custom]\nruleset=🚀 节点选择,[]FINAL\ncustom_proxy_group=🚀 节点选择`select`[]DIRECT\n', { status: 200 })));

        const result = await fetchTransformTemplate(badCacheStore, 'https://example.com/bad.ini', false);

        expect(result).toContain('custom_proxy_group=');
        expect(badCacheStore.put).toHaveBeenCalled();
    });
});
