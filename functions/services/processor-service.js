/**
 * MiSub Core Processing Service
 * Handles the logic of: Profile Resolving -> Node Fetching -> Transformation Pipeline -> Response Rendering
 */

import { generateCombinedNodeList } from './subscription-service.js';
import { transformBuiltinSubscription } from '../modules/subscription/transformer-factory.js';
import { renderClashFromIniTemplate, renderSingboxFromIniTemplate, renderSurgeFromIniTemplate, renderLoonFromIniTemplate, renderQuanxFromIniTemplate, renderEgernFromIniTemplate, extractRuleSetUrlsFromIniTemplate } from '../modules/subscription/template-pipeline.js';
import { getBuiltinTemplate } from '../modules/subscription/builtin-template-registry.js';
import { fetchTransformTemplate } from '../modules/subscription/transform-template-cache.js';
import { fetchRuleSetBatch } from '../modules/subscription/rule-set-fetcher.js';

/**
 * 判断模板渲染输出是否"形式上是空"（代理组为空、无规则）。
 * 这种情况通常是远端模板拉取不完整或缓存了脏数据导致。
 * 命中此判断时调用方应退回 builtin 生成器，保证客户端依然能用。
 */
function isTemplateRenderEmpty(content, targetFormat) {
    if (typeof content !== 'string' || content.trim().length === 0) return true;
    const fmt = String(targetFormat || '').toLowerCase();
    if (fmt === 'clash' || fmt === 'egern') {
        // YAML：检测 proxy-groups: [] 或 proxy-groups 下无条目
        if (/\nproxy-groups:\s*\[\s*\]/.test(content)) return true;
        if (/\npolicy_groups:\s*\[\s*\]/.test(content)) return true;
    }
    if (fmt === 'singbox' || fmt === 'sing-box') {
        try {
            const json = JSON.parse(content);
            const outbounds = Array.isArray(json.outbounds) ? json.outbounds : [];
            const groupOutbounds = outbounds.filter(o => o && (o.type === 'selector' || o.type === 'urltest'));
            if (groupOutbounds.length === 0) return true;
        } catch (e) {
            return true;
        }
    }
    if (fmt === 'surge' || fmt.startsWith('surge&') || fmt === 'loon' || fmt === 'quanx') {
        // INI 类格式：Proxy Group / Policy 段之间若没有任何策略组行，视为空
        const section = content.match(/\[(?:Proxy Group|Policy)\]([\s\S]*?)(?=\n\[|$)/i);
        if (!section) return true;
        const hasGroupLine = section[1]
            .split('\n')
            .some(line => {
                const t = line.trim();
                return t.length > 0 && !t.startsWith('#') && !t.startsWith(';') && t.includes('=');
            });
        if (!hasGroupLine) return true;
    }
    return false;
}

export class ProcessorService {
    /**
     * Generate nodes based on target format and configuration
     * @param {Object} context 
     * @param {Object} config 
     * @param {Object} params 
     */
    static async processNodes(context, config, params) {
        const { 
            userAgent, 
            targetMisubs, 
            prependedContent, 
            generationSettings, 
            isDebugToken, 
            shouldSkipCertVerify 
        } = params;

        // 1. Fetch and combine nodes
        const combinedNodeList = await generateCombinedNodeList(
            context,
            { ...config, enableAccessLog: false },
            userAgent,
            targetMisubs,
            prependedContent,
            generationSettings,
            isDebugToken,
            shouldSkipCertVerify
        );

        return combinedNodeList;
    }

    /**
     * Render the combined node list into the final format
     * @param {Object} options 
     */
    static async renderOutput(options) {
        const {
            targetFormat,
            combinedNodeList,
            subName,
            config,
            builtinOptions,
            templateSource,
            managedConfigUrl,
            storageAdapter,
            userInfoHeader,
            forceRefresh = false,
            ruleMode = 'inline'
        } = options;

        // Check for Base64 (simplest case)
        if (targetFormat === 'base64') {
            return {
                content: btoa(unescape(encodeURIComponent(combinedNodeList))),
                contentType: 'text/plain; charset=utf-8',
                headers: userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {}
            };
        }

        // Handle built-in generation with optional templates
        const builtinProxyContent = transformBuiltinSubscription(combinedNodeList, targetFormat, {
            ...builtinOptions,
            managedConfigUrl: ''
        });

        if (!builtinProxyContent) {
            // Fallback to raw Base64 if generator fails
            return {
                content: btoa(unescape(encodeURIComponent(combinedNodeList))),
                contentType: 'text/plain; charset=utf-8',
                headers: userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {}
            };
        }

        let finalContent = builtinProxyContent;
        let contentType = 'text/plain; charset=utf-8';
        const headers = userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {};

        const builtinTemplateEntry = templateSource.kind === 'builtin' ? getBuiltinTemplate(templateSource.value) : null;
        const remoteTemplateUrl = templateSource.kind === 'remote' ? templateSource.value : '';

        if (builtinTemplateEntry || remoteTemplateUrl) {
            const templateText = builtinTemplateEntry?.content || await fetchTransformTemplate(storageAdapter, remoteTemplateUrl, forceRefresh);
            const isIniTemplate = builtinTemplateEntry?.format === 'ini' || (remoteTemplateUrl && remoteTemplateUrl.toLowerCase().endsWith('.ini'));

            // [防御] 模板内容判定：空白或完全无关键字段 (custom_proxy_group / ruleset / [Proxy Group] / [Rule]) 视为无效，
            // 不走模板路径，保留 builtin 默认输出，避免产生 proxy-groups: [] 这类看似成功但不可用的空配置。
            const hasTemplateKeywords = typeof templateText === 'string'
                && templateText.trim().length > 0
                && /(^|\n)\s*(custom_proxy_group\s*=|ruleset\s*=|\[Proxy Group\]|\[Rule\])/i.test(templateText);

            if (templateText && isIniTemplate && hasTemplateKeywords) {
                const renderParams = {
                    nodeList: combinedNodeList,
                    fileName: subName,
                    targetFormat,
                    ruleLevel: builtinOptions.ruleLevel,
                    interval: config.UpdateInterval || 86400,
                    managedConfigUrl,
                    skipCertVerify: builtinOptions.skipCertVerify,
                    enableUdp: builtinOptions.enableUdp,
                    ruleMode
                };

                // 仅 clash 目标支持 inline 展开，其它目标仍按原路径。
                // 预取所有 RULE-SET 的 .list 内容，由 MiSub 后端代拉并 KV 缓存，解决路由器
                // 场景（OpenClash / OpenWrt）下无法直拉 GitHub raw 的困境。
                if (targetFormat === 'clash' && ruleMode === 'inline') {
                    try {
                        const ruleSetUrls = extractRuleSetUrlsFromIniTemplate(templateText, { targetFormat });
                        if (ruleSetUrls.length > 0) {
                            renderParams.ruleSetContents = await fetchRuleSetBatch(storageAdapter, ruleSetUrls, forceRefresh);
                            console.log(`[Template] Inline mode: fetched ${renderParams.ruleSetContents.size}/${ruleSetUrls.length} rule-sets`);
                        }
                    } catch (e) {
                        console.warn('[Template] Pre-fetch rule-sets failed, will fall back to rule-providers', e?.message || e);
                    }
                }

                let rendered = null;
                switch (targetFormat) {
                    case 'clash':
                        rendered = renderClashFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty clash config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                            contentType = 'application/x-yaml; charset=utf-8';
                        }
                        break;
                    case 'singbox':
                    case 'sing-box':
                        rendered = renderSingboxFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty singbox config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                            contentType = 'application/json; charset=utf-8';
                        }
                        break;
                    case 'surge':
                    case 'surge&ver=4':
                        rendered = renderSurgeFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty surge config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                        }
                        break;
                    case 'loon':
                        rendered = renderLoonFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty loon config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                        }
                        break;
                    case 'quanx':
                        rendered = renderQuanxFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty quanx config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                        }
                        break;
                    case 'egern':
                        rendered = renderEgernFromIniTemplate(templateText, renderParams);
                        if (isTemplateRenderEmpty(rendered, targetFormat)) {
                            console.warn('[Template] Rendered empty egern config; falling back to builtin generator');
                        } else {
                            finalContent = rendered;
                            contentType = 'application/x-yaml; charset=utf-8';
                        }
                        break;
                }
            } else if (templateText && isIniTemplate && !hasTemplateKeywords) {
                console.warn('[Template] Remote template has no recognizable ACL rules/groups; falling back to builtin generator');
            }
        }

        // Set proper content type for built-in formats if not set by template
        if (contentType === 'text/plain; charset=utf-8') {
             if (targetFormat === 'clash' || targetFormat === 'egern') contentType = 'application/x-yaml; charset=utf-8';
             else if (targetFormat === 'singbox' || targetFormat === 'sing-box') contentType = 'application/json; charset=utf-8';
        }

        return {
            content: finalContent,
            contentType,
            headers
        };
    }
}
