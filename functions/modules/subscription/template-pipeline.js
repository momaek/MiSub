import { parseIniTemplate } from './template-parsers/ini-template-parser.js';
import { applySmartModelOptimizations } from './template-processor.js';
import { renderClashFromTemplateModel } from './template-renderers/render-clash.js';
import { renderSingboxFromTemplateModel } from './template-renderers/render-singbox.js';
import { renderSurgeFromTemplateModel } from './template-renderers/render-surge.js';
import { renderLoonFromTemplateModel } from './template-renderers/render-loon.js';
import { renderQuanxFromTemplateModel } from './template-renderers/render-quanx.js';
import { renderEgernFromTemplateModel } from './template-renderers/render-egern.js';
import { urlsToClashProxies } from '../../utils/url-to-clash.js';

/**
 * 从 INI 模板里提取出所有 RULE-SET 对应的远端 URL，便于渲染前批量预取 rule-set 文本。
 */
export function extractRuleSetUrlsFromIniTemplate(templateText, options = {}) {
    const model = parseIniTemplate(templateText, options);
    const urls = [];
    for (const rule of model.rules || []) {
        const type = String(rule.type || '').toUpperCase();
        if (type === 'RULE-SET' && typeof rule.value === 'string' && /^https?:\/\//i.test(rule.value)) {
            urls.push(rule.value);
        }
    }
    return [...new Set(urls)];
}

export function renderClashFromIniTemplate(templateText, options = {}) {
    const nodeList = typeof options.nodeList === 'string' ? options.nodeList : '';
    const proxyUrls = nodeList
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    const proxies = Array.isArray(options.proxies) ? options.proxies : urlsToClashProxies(proxyUrls);

    let model = parseIniTemplate(templateText, {
        ...options,
        proxies
    });

    // 智能注入地区分组逻辑
    model = applySmartModelOptimizations(model);

    return renderClashFromTemplateModel(model, {
        ruleMode: options.ruleMode || 'inline',
        ruleSetContents: options.ruleSetContents || null
    });
}

export function renderSingboxFromIniTemplate(templateText, options = {}) {
    let model = parseIniTemplate(templateText, options);
    model = applySmartModelOptimizations(model);
    return renderSingboxFromTemplateModel(model, options);
}

export function renderSurgeFromIniTemplate(templateText, options = {}) {
    let model = parseIniTemplate(templateText, options);
    model = applySmartModelOptimizations(model);
    return renderSurgeFromTemplateModel(model, options);
}

export function renderLoonFromIniTemplate(templateText, options = {}) {
    let model = parseIniTemplate(templateText, options);
    model = applySmartModelOptimizations(model);
    return renderLoonFromTemplateModel(model, options);
}

export function renderQuanxFromIniTemplate(templateText, options = {}) {
    let model = parseIniTemplate(templateText, options);
    model = applySmartModelOptimizations(model);
    return renderQuanxFromTemplateModel(model, options);
}

export function renderEgernFromIniTemplate(templateText, options = {}) {
    const nodeList = typeof options.nodeList === 'string' ? options.nodeList : '';
    const proxyUrls = nodeList
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    const proxies = Array.isArray(options.proxies) ? options.proxies : urlsToClashProxies(proxyUrls);

    let model = parseIniTemplate(templateText, {
        ...options,
        proxies
    });
    model = applySmartModelOptimizations(model);
    return renderEgernFromTemplateModel(model);
}
