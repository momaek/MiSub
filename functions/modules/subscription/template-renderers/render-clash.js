import yaml from 'js-yaml';
import { clashFix } from '../../../utils/format-utils.js';
import { normalizeUnifiedTemplateModel } from '../template-model.js';
import { hasGroupContent, resolveGroupMembers } from '../template-group-utils.js';

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

export function renderClashFromTemplateModel(model) {
    const normalizedModel = normalizeUnifiedTemplateModel(model);
    
    // 生成 Rule Providers
    const ruleProviders = {};
    const ruleProviderMap = new Map();
    let providerCounter = 0;

    normalizedModel.rules.forEach(rule => {
        const type = String(rule.type || '').toUpperCase();
        if (type === 'RULE-SET' && rule.value && /^https?:\/\//i.test(rule.value)) {
            if (!ruleProviderMap.has(rule.value)) {
                // 生成一个可读性较好的名称，尝试从 URL 获取文件名
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
        'rules': normalizedModel.rules.map(r => mapRule(r, ruleProviderMap)).filter(Boolean),
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
