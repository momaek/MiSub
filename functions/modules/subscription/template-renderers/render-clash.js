import yaml from 'js-yaml';
import { clashFix } from '../../../utils/format-utils.js';
import { normalizeUnifiedTemplateModel } from '../template-model.js';
import { hasGroupContent, resolveGroupMembers } from '../template-group-utils.js';
import { parseRuleSetLines } from '../rule-set-fetcher.js';

function mapGroupType(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'url-test' || normalized === 'fallback' || normalized === 'load-balance' || normalized === 'relay' || normalized === 'select') {
        return normalized;
    }
    return 'select';
}

function filterAutoSelectMembers(group) {
    const type = mapGroupType(group.type);
    const members = Array.isArray(group.members) ? group.members.filter(Boolean) : [];
    if (!['url-test', 'fallback', 'load-balance'].includes(type)) {
        return members;
    }
    return members.filter(member => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(String(member).toUpperCase()));
}

// 对于 ACL4SSR 风格的"filter-only 分组"（如 `🇭🇰 香港节点`load-balance`(港|HK|...)` 或
// `☑️ 手动切换`select`.*`），若没有显式成员，则用 filter 正则去匹配全量代理名生成 proxies 列表，
// 以保证在不支持 Mihomo `filter` 字段的 Clash 变种中依然可用。
function resolveGroupProxies(group, allProxyNames) {
    const members = filterAutoSelectMembers(group);
    if (members.length > 0) return members;
    return resolveGroupMembers(group, allProxyNames);
}

function mapRule(rule, ruleProviderMap) {
    const type = String(rule.type || '').toUpperCase();
    if (!type) return null;
    if (type === 'MATCH' || type === 'FINAL') return `MATCH,${rule.policy}`;
    if (type === 'GEOIP') return `GEOIP,${rule.value || 'CN'},${rule.policy}`;
    if (type === 'RULE-SET') {
        const providerName = ruleProviderMap.get(rule.value);
        return `RULE-SET,${providerName || rule.value},${rule.policy}`;
    }
    return `${type},${rule.value},${rule.policy}`;
}

/**
 * 将原始 .list 行 (可能含 no-resolve 等修饰) 转成一条完整 Clash rule 字符串。
 * 注意：远端 .list 中若自带 policy（例如 `DOMAIN,x.com,DIRECT`），一律忽略其原始 policy，
 * 统一改写为模板里本条 ruleset 指定的 policy，保证行为和 rule-provider 模式一致。
 */
function inlineRuleSetLineToClashRule(rawLine, policy) {
    if (typeof rawLine !== 'string') return null;
    const parts = rawLine.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const type = parts[0].toUpperCase();

    // 忽略 rule-set 内出现的 "递归" 引用（不应发生，但防御性处理）
    if (type === 'RULE-SET') return null;

    // FINAL / MATCH 放进 ruleset 里也忽略（一般模板自己最后会有 MATCH 兜底）
    if (type === 'MATCH' || type === 'FINAL') return null;

    if (type === 'GEOIP') {
        const value = parts[1] || 'CN';
        // 如果 parts[2] 看起来像策略（如 DIRECT/Proxy），忽略之，否则保留作为修饰（no-resolve）
        const tail = parts.slice(2).filter(p => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(p.toUpperCase()) && !p.includes(' '));
        const suffix = tail.length > 0 ? `,${tail.join(',')}` : '';
        return `GEOIP,${value},${policy}${suffix}`;
    }

    const value = parts[1];
    // parts[2..] 里可能有原 policy 或修饰（no-resolve）。
    // 策略类值一般是单词或含空格的组名，为简单起见：仅保留白名单修饰 (no-resolve, src, extra)
    const extras = parts.slice(2).filter(p => /^(no-resolve|src|extra)$/i.test(p));
    const suffix = extras.length > 0 ? `,${extras.join(',')}` : '';
    return `${type},${value},${policy}${suffix}`;
}

export function renderClashFromTemplateModel(model, renderOptions = {}) {
    const normalizedModel = normalizeUnifiedTemplateModel(model);

    // 规则输出模式：
    //   'inline'    - 由调用方预取的 ruleSetContents 展开成具体规则（推荐，默认）
    //   'providers' - 保留 rule-providers 引用（客户端自己拉 .list）
    const { ruleMode = 'inline', ruleSetContents = null } = renderOptions;
    const hasRuleSetContents = ruleSetContents instanceof Map && ruleSetContents.size > 0;
    const useInline = ruleMode === 'inline' && hasRuleSetContents;

    // 生成 Rule Providers（即便 inline 模式，若某个 URL 没有预取成功，也会降级为 rule-provider 引用，避免规则丢失）
    const ruleProviders = {};
    const ruleProviderMap = new Map();
    let providerCounter = 0;

    normalizedModel.rules.forEach(rule => {
        const type = String(rule.type || '').toUpperCase();
        if (type === 'RULE-SET' && rule.value && /^https?:\/\//i.test(rule.value)) {
            // inline 模式下已经能解析的 URL 无需注册为 provider
            if (useInline && ruleSetContents.has(rule.value)) return;
            if (!ruleProviderMap.has(rule.value)) {
                let nameHint = 'rs';
                let extHint = '';
                try {
                    const urlPath = new URL(rule.value).pathname;
                    const rawFileName = urlPath.split('/').pop() || '';
                    const extMatch = rawFileName.match(/\.(yaml|yml|list|txt|conf|mrs)$/i);
                    extHint = extMatch ? extMatch[1].toLowerCase() : '';
                    const fileName = rawFileName.replace(/\.(yaml|yml|list|txt|conf|mrs)$/i, '');
                    if (fileName && fileName.length > 2) {
                        nameHint = fileName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                    }
                } catch (e) { /* ignore */ }

                // 根据源文件扩展名推断 format 和本地缓存后缀，避免 Mihomo / Clash Meta
                // 按默认的 yaml 去解析 ACL4SSR 的 .list 等文本规则集（会 0 条规则加载成功）。
                let format = 'yaml';
                let pathExt = 'yaml';
                if (extHint === 'list' || extHint === 'txt' || extHint === 'conf') {
                    format = 'text';
                    pathExt = 'txt';
                } else if (extHint === 'mrs') {
                    format = 'mrs';
                    pathExt = 'mrs';
                } else if (extHint === 'yml') {
                    format = 'yaml';
                    pathExt = 'yaml';
                }

                const providerName = `${nameHint}_${providerCounter++}`;
                ruleProviderMap.set(rule.value, providerName);

                ruleProviders[providerName] = {
                    type: 'http',
                    behavior: 'classical',
                    format,
                    url: rule.value,
                    path: `./ruleset/${providerName}.${pathExt}`,
                    interval: 86400
                };
            }
        }
    });

    // 生成最终 rules 列表
    const finalRules = [];
    for (const rule of normalizedModel.rules) {
        const type = String(rule.type || '').toUpperCase();
        if (type === 'RULE-SET' && rule.value && useInline && ruleSetContents.has(rule.value)) {
            // 展开 rule-set 内容为具体规则
            const lines = parseRuleSetLines(ruleSetContents.get(rule.value));
            for (const rawLine of lines) {
                const mapped = inlineRuleSetLineToClashRule(rawLine, rule.policy);
                if (mapped) finalRules.push(mapped);
            }
        } else {
            const mapped = mapRule(rule, ruleProviderMap);
            if (mapped) finalRules.push(mapped);
        }
    }

    const allProxyNames = normalizedModel.proxies.map(p => p && p.name).filter(Boolean);

    const config = {
        'mixed-port': 7890,
        'allow-lan': true,
        'mode': 'rule',
        'log-level': 'info',
        'external-controller': ':9090',
        'proxies': normalizedModel.proxies,
        'proxy-groups': normalizedModel.groups
            .filter(hasGroupContent)
            .map(group => ({
                name: group.name,
                type: mapGroupType(group.type),
                proxies: resolveGroupProxies(group, allProxyNames),
                filter: Array.isArray(group.filters) && group.filters.length > 0 ? group.filters.join('|') : undefined,
                ...group.options
            })),
        'rule-providers': Object.keys(ruleProviders).length > 0 ? ruleProviders : undefined,
        'rules': finalRules,
        'profile': {
            'store-selected': true,
            'subscription-url': normalizedModel.settings.managedConfigUrl || ''
        }
    };

    let yamlStr = yaml.dump(config, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false
    });
    yamlStr = clashFix(yamlStr);
    return yamlStr;
}
