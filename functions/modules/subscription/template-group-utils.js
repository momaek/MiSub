// 共用工具：将 ACL4SSR 模板里"只有 filter 没有显式 members"的分组
// （例如 `☑️ 手动切换`select`.*` 或 `🇭🇰 香港节点`load-balance`(港|HK|...)`）
// 展开为一组具体的 proxy 名称，保证各 renderer（Clash/Surge/Loon/QuanX/Sing-box）
// 都不会再把这些组整段丢弃。

/**
 * 判断一个 proxy group 是否应被保留（有显式成员或有 filter）。
 * @param {{ members?: string[], filters?: string[] }} group
 * @returns {boolean}
 */
export function hasGroupContent(group) {
    if (!group) return false;
    const hasMembers = Array.isArray(group.members) && group.members.length > 0;
    const hasFilters = Array.isArray(group.filters) && group.filters.length > 0;
    return hasMembers || hasFilters;
}

/**
 * 将 group.filters 合并成一个正则，尝试匹配全量代理名。
 * @param {string[]} filters
 * @param {string[]} allProxyNames
 * @returns {string[]}
 */
export function matchProxyNamesByFilters(filters, allProxyNames) {
    const normalizedFilters = Array.isArray(filters) ? filters.filter(Boolean) : [];
    if (normalizedFilters.length === 0 || !Array.isArray(allProxyNames) || allProxyNames.length === 0) {
        return [];
    }
    const combined = normalizedFilters.join('|');
    try {
        const re = new RegExp(combined);
        const matched = allProxyNames.filter(name => re.test(name));
        if (matched.length > 0) return matched;
    } catch (e) { /* 正则非法时回退 */ }
    return allProxyNames.slice();
}

/**
 * 解析一个分组最终应输出的 members：
 *  - 若已有显式 members，直接返回（由调用方再做 url-test 等类型特定的清洗）
 *  - 若只有 filters，则按正则从 allProxyNames 中提取
 * @param {{ members?: string[], filters?: string[] }} group
 * @param {string[]} allProxyNames
 * @returns {string[]}
 */
export function resolveGroupMembers(group, allProxyNames) {
    const members = Array.isArray(group?.members) ? group.members.filter(Boolean) : [];
    if (members.length > 0) return members;
    return matchProxyNamesByFilters(group?.filters, allProxyNames);
}

