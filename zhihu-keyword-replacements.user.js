// ==UserScript==
// @name         知乎关键词替换
// @namespace    https://github.com/kristhl181/zhihu-keyword-replacements
// @version      1.0.0
// @description  按作者/全局规则组自动替换知乎页面中的关键词，支持正则，监听动态加载
// @author       KrisTHL181
// @match        https://www.zhihu.com/*
// @match        https://zhuanlan.zhihu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // ============================================================
    // 常量
    // ============================================================
    const STORAGE_KEY = "zhihu_kw_data";

    // 内容区域选择器
    const CONTENT_SELECTORS = [
        ".RichText",
        ".QuestionHeader-title",
        ".ContentItem-title",
        ".AuthorInfo-name",
        ".AuthorInfo-headline",
        ".Feed-content",
        ".SearchItem-title",
        ".Comments-item-content",
        ".PinItem-content",
    ];

    // 作者名选择器（按优先级排列）
    const AUTHOR_NAME_SELECTORS = [
        ".AuthorInfo-name",
        ".UserLink-link",
        "[itemprop='author'] [itemprop='name']",
        "meta[itemprop='name']",
    ];

    // 内容卡片容器选择器 — 向上查找这些元素来确定一个内容块属于哪个作者
    const CARD_SELECTORS = [
        ".List-item",
        ".AnswerCard",
        ".ContentItem",
        ".TopstoryItem",
        ".Post-page",
        "article",
        ".Comments-item",
        ".PinItem",
    ];

    const SKIP_TAGS = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT",
        "INPUT", "TEXTAREA", "SELECT", "CODE", "PRE",
        "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO",
    ]);

    const PANEL_ID = "zhihu-kw-panel";

    // ============================================================
    // 数据模型
    // ============================================================
    function makeGroupId() {
        return "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    }

    function getDefaultData() {
        return {
            enabled: true,
            activeGroupId: "g_default",
            groups: [
                {
                    id: "g_default",
                    name: "全局默认",
                    authors: "",
                    rules: [
                        { id: 1, find: "", replace: "", isRegex: false, enabled: true },
                    ],
                },
            ],
        };
    }

    // ============================================================
    // 存储
    // ============================================================
    function loadData() {
        try {
            return GM_getValue(STORAGE_KEY, getDefaultData());
        } catch (e) {
            return getDefaultData();
        }
    }

    function saveData(data) {
        GM_setValue(STORAGE_KEY, data);
    }

    function loadGroups() {
        return loadData().groups;
    }

    function loadGroup(groupId) {
        return loadGroups().find(function (g) { return g.id === groupId; });
    }

    function saveGroups(groups) {
        var data = loadData();
        data.groups = groups;
        saveData(data);
    }

    function isEnabled() {
        return loadData().enabled;
    }

    function setEnabled(val) {
        var data = loadData();
        data.enabled = val;
        saveData(data);
    }

    function getActiveGroupId() {
        var data = loadData();
        var groups = data.groups;
        // 确保 activeGroupId 指向存在的组
        if (!groups.some(function (g) { return g.id === data.activeGroupId; })) {
            data.activeGroupId = groups.length > 0 ? groups[0].id : "g_default";
            saveData(data);
        }
        return data.activeGroupId;
    }

    function setActiveGroupId(groupId) {
        var data = loadData();
        data.activeGroupId = groupId;
        saveData(data);
    }

    // ============================================================
    // 作者检测 — 向上遍历 DOM 找到内容所属的作者名
    // ============================================================
    function findCardContainer(el) {
        var current = el;
        while (current && current !== document.body) {
            for (var i = 0; i < CARD_SELECTORS.length; i++) {
                if (current.matches && current.matches(CARD_SELECTORS[i])) {
                    return current;
                }
            }
            current = current.parentElement;
        }
        return null;
    }

    function findAuthorInCard(card) {
        if (!card) return null;
        for (var i = 0; i < AUTHOR_NAME_SELECTORS.length; i++) {
            var el = card.querySelector(AUTHOR_NAME_SELECTORS[i]);
            if (el && el.textContent && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return null;
    }

    function detectAuthor(element) {
        // 从给定元素出发，向上找到内容卡片，再提取作者名
        var card = findCardContainer(element);
        return findAuthorInCard(card);
    }

    // ============================================================
    // 作者匹配 — 检查作者名是否匹配规则组的 authors 字段
    // ============================================================
    function groupMatchesAuthor(group, authorName) {
        if (!authorName) return false;
        if (!group.authors || !group.authors.trim()) return false; // 空 = 全局组，不匹配具体作者

        var patterns = group.authors.split(/[,，\s]+/).filter(Boolean);
        var lowerName = authorName.toLowerCase();
        for (var i = 0; i < patterns.length; i++) {
            var p = patterns[i].toLowerCase();
            if (p === lowerName) return true;
            // 支持模糊匹配：模式作为子串出现在作者名中
            if (lowerName.indexOf(p) !== -1) return true;
        }
        return false;
    }

    // ============================================================
    // 文本替换引擎
    // ============================================================
    function createReplacer(rule) {
        if (!rule.find || !rule.enabled) return null;

        if (rule.isRegex) {
            try {
                var regex = new RegExp(rule.find, "gi");
                return function (text) {
                    return text.replace(regex, rule.replace);
                };
            } catch (e) {
                console.warn("[知乎关键词替换] 无效正则:", rule.find, e.message);
                return null;
            }
        }

        var lower = rule.find.toLowerCase();
        return function (text) {
            if (text.toLowerCase().indexOf(lower) !== -1) {
                var escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return text.replace(new RegExp(escaped, "gi"), rule.replace);
            }
            return text;
        };
    }

    function buildReplacersForAuthor(authorName) {
        var groups = loadGroups();
        var activeRules = [];

        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var isGlobal = !group.authors || !group.authors.trim();
            var matchesAuthor = authorName && groupMatchesAuthor(group, authorName);

            if (isGlobal || matchesAuthor) {
                for (var ri = 0; ri < group.rules.length; ri++) {
                    activeRules.push(group.rules[ri]);
                }
            }
        }

        var replacers = [];
        for (var i = 0; i < activeRules.length; i++) {
            var r = createReplacer(activeRules[i]);
            if (r) replacers.push(r);
        }
        return replacers;
    }

    function replaceInNode(textNode, replacers) {
        if (replacers.length === 0) return;

        var parent = textNode.parentNode;
        if (!parent || SKIP_TAGS.has(parent.nodeName)) return;

        var original = textNode.nodeValue;
        if (!original || !original.trim()) return;

        var result = original;
        var changed = false;
        for (var i = 0; i < replacers.length; i++) {
            var before = result;
            result = replacers[i](result);
            if (result !== before) changed = true;
        }

        if (changed) {
            textNode.nodeValue = result;
        }
    }

    function shouldSkipElement(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el.isContentEditable) return true;
        if (el.getAttribute("contenteditable") === "true") return true;
        if (SKIP_TAGS.has(el.nodeName)) return true;
        if (el.closest && el.closest("#" + PANEL_ID)) return true;
        return false;
    }

    function processTextNodes(root, replacers) {
        if (replacers.length === 0) return;
        if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return;

        var walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    var parent = node.parentNode;
                    if (!parent || SKIP_TAGS.has(parent.nodeName)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (parent.isContentEditable) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (parent.closest && parent.closest("#" + PANEL_ID)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                },
            }
        );

        var nodes = [];
        var node;
        while ((node = walker.nextNode())) {
            nodes.push(node);
        }

        for (var i = 0; i < nodes.length; i++) {
            replaceInNode(nodes[i], replacers);
        }
    }

    // ============================================================
    // 作者感知的内容处理
    // ============================================================
    function processContentWithAuthor(root) {
        var authorName = detectAuthor(root);
        var replacers = buildReplacersForAuthor(authorName);
        processTextNodes(root, replacers);
    }

    function processAllContent() {
        // 先按选择器找内容区域
        var roots = [];
        for (var i = 0; i < CONTENT_SELECTORS.length; i++) {
            var elements = document.querySelectorAll(CONTENT_SELECTORS[i]);
            for (var j = 0; j < elements.length; j++) {
                if (roots.indexOf(elements[j]) === -1) {
                    roots.push(elements[j]);
                }
            }
        }

        if (roots.length === 0) {
            // 回退：处理 body 下所有文本（仅应用全局规则）
            processTextNodes(document.body, buildReplacersForAuthor(null));
            return;
        }

        for (var k = 0; k < roots.length; k++) {
            processContentWithAuthor(roots[k]);
        }
    }

    // ============================================================
    // MutationObserver
    // ============================================================
    var observer = null;
    var pendingNodes = [];
    var debounceTimer = null;

    function flushMutations() {
        var nodes = pendingNodes.slice();
        pendingNodes = [];

        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].isConnected) {
                processContentWithAuthor(nodes[i]);
            }
        }
    }

    function setupObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(function (mutations) {
            if (!isEnabled()) return;

            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];

                // 新增节点
                for (var j = 0; j < mutation.addedNodes.length; j++) {
                    var node = mutation.addedNodes[j];
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        pendingNodes.push(node);
                    }
                }

                // characterData 变化 — 立即处理
                if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
                    var authorName = detectAuthor(mutation.target);
                    replaceInNode(mutation.target, buildReplacersForAuthor(authorName));
                }
            }

            if (pendingNodes.length > 0) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(flushMutations, 300);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    // ============================================================
    // UI — 规则组管理面板
    // ============================================================
    var PANEL_HTML =
    '<div id="zhihu-kw-panel-overlay" style="display:none;">' +
    '  <div id="' + PANEL_ID + '">' +
    '    <div id="zhihu-kw-panel-header">' +
    '      <h3>关键词替换规则</h3>' +
    '      <button id="zhihu-kw-panel-close">&times;</button>' +
    '    </div>' +
    '    <div id="zhihu-kw-panel-body">' +
    '      <div id="zhihu-kw-group-bar">' +
    '        <select id="zhihu-kw-group-select"></select>' +
    '        <button id="zhihu-kw-group-new" title="新建规则组">+</button>' +
    '        <button id="zhihu-kw-group-delete" title="删除当前组">-</button>' +
    '      </div>' +
    '      <div id="zhihu-kw-group-meta">' +
    '        <input type="text" id="zhihu-kw-group-name" placeholder="规则组名称" maxlength="30">' +
    '        <input type="text" id="zhihu-kw-group-authors" placeholder="匹配作者（逗号分隔，留空=全局）">' +
    '        <span class="zhihu-kw-hint">匹配作者名（支持部分匹配），留空则为全局规则</span>' +
    '      </div>' +
    '      <div id="zhihu-kw-rules-list"></div>' +
    '      <button id="zhihu-kw-add-rule">+ 添加替换规则</button>' +
    '    </div>' +
    '    <div id="zhihu-kw-panel-footer">' +
    '      <label id="zhihu-kw-enabled-label">' +
    '        <input type="checkbox" id="zhihu-kw-enabled-check" checked>' +
    '        启用替换' +
    '      </label>' +
    '      <div id="zhihu-kw-panel-actions">' +
    '        <button id="zhihu-kw-btn-save">保存</button>' +
    '        <button id="zhihu-kw-btn-reset">重置全部</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<button id="zhihu-kw-toggle-btn" title="关键词替换">Kw</button>';

    function injectStyles() {
        GM_addStyle(
            "#zhihu-kw-toggle-btn {" +
            "  position:fixed;bottom:20px;right:20px;z-index:9998;" +
            "  width:40px;height:40px;border-radius:50%;border:none;" +
            "  background:#06f;color:#fff;font-size:13px;font-weight:700;" +
            "  cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);" +
            "  display:flex;align-items:center;justify-content:center;" +
            "  transition:transform .2s,opacity .2s;" +
            "}" +
            "#zhihu-kw-toggle-btn:hover{transform:scale(1.1);}" +
            "#zhihu-kw-toggle-btn.disabled{background:#999;}" +
            "#zhihu-kw-panel-overlay{" +
            "  position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;" +
            "  background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;" +
            "}" +
            "#" + PANEL_ID + "{" +
            "  background:#fff;border-radius:8px;width:560px;max-width:92vw;max-height:85vh;" +
            "  box-shadow:0 4px 24px rgba(0,0,0,.15);display:flex;flex-direction:column;" +
            "}" +
            "#zhihu-kw-panel-header{" +
            "  display:flex;justify-content:space-between;align-items:center;" +
            "  padding:14px 20px;border-bottom:1px solid #eee;" +
            "}" +
            "#zhihu-kw-panel-header h3{margin:0;font-size:16px;color:#1a1a1a;}" +
            "#zhihu-kw-panel-close{background:none;border:none;font-size:22px;cursor:pointer;color:#999;padding:0 4px;}" +
            "#zhihu-kw-panel-close:hover{color:#333;}" +
            "#zhihu-kw-panel-body{padding:14px 20px;overflow-y:auto;flex:1;}" +
            "#zhihu-kw-group-bar{display:flex;gap:6px;margin-bottom:10px;align-items:center;}" +
            "#zhihu-kw-group-select{flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;}" +
            "#zhihu-kw-group-new,#zhihu-kw-group-delete{" +
            "  width:30px;height:30px;border:1px solid #ddd;border-radius:4px;" +
            "  background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;" +
            "}" +
            "#zhihu-kw-group-new:hover{background:#e6f0ff;border-color:#06f;color:#06f;}" +
            "#zhihu-kw-group-delete:hover{background:#ffe6e6;border-color:#e55;color:#e55;}" +
            "#zhihu-kw-group-meta{margin-bottom:12px;}" +
            "#zhihu-kw-group-meta input[type='text']{" +
            "  width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:4px;" +
            "  font-size:13px;box-sizing:border-box;margin-bottom:4px;" +
            "}" +
            "#zhihu-kw-group-meta input[type='text']:focus{border-color:#06f;outline:none;}" +
            "#zhihu-kw-group-name{font-weight:600;}" +
            ".zhihu-kw-hint{font-size:11px;color:#999;}" +
            "#zhihu-kw-panel-footer{" +
            "  padding:12px 20px;border-top:1px solid #eee;" +
            "  display:flex;justify-content:space-between;align-items:center;" +
            "}" +
            "#zhihu-kw-enabled-label{font-size:13px;color:#666;cursor:pointer;display:flex;align-items:center;gap:6px;}" +
            "#zhihu-kw-panel-actions{display:flex;gap:8px;}" +
            "#zhihu-kw-panel-actions button,#zhihu-kw-add-rule{" +
            "  padding:6px 14px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:13px;" +
            "}" +
            "#zhihu-kw-add-rule{width:100%;margin-top:8px;color:#06f;border-color:#06f;}" +
            "#zhihu-kw-add-rule:hover{background:#e6f0ff;}" +
            "#zhihu-kw-btn-save{background:#06f!important;color:#fff!important;border-color:#06f!important;}" +
            "#zhihu-kw-btn-save:hover{background:#0052a3!important;}" +
            "#zhihu-kw-btn-reset:hover{background:#f5f5f5;}" +
            ".zhihu-kw-rule-row{" +
            "  display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;" +
            "}" +
            ".zhihu-kw-rule-row input[type='text']{" +
            "  padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;flex:1;min-width:80px;" +
            "}" +
            ".zhihu-kw-rule-row input[type='text']:focus{border-color:#06f;outline:none;}" +
            ".zhihu-kw-rule-row label{" +
            "  font-size:11px;color:#666;display:flex;align-items:center;gap:3px;white-space:nowrap;cursor:pointer;" +
            "}" +
            ".zhihu-kw-rule-delete{" +
            "  background:none!important;border:none!important;color:#e55!important;" +
            "  cursor:pointer;font-size:16px;padding:0 4px!important;" +
            "}" +
            ".zhihu-kw-rule-delete:hover{color:#c00!important;}" +
            "#zhihu-kw-group-delete[disabled]{opacity:.3;cursor:not-allowed;}" +
            ".zhihu-kw-empty-groups{" +
            "  text-align:center;padding:20px;color:#999;font-size:13px;" +
            "}"
        );
    }

    // ---- UI 渲染 ----

    function escapeAttr(s) {
        return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                .replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function createRuleRow(rule) {
        var row = document.createElement("div");
        row.className = "zhihu-kw-rule-row";
        row.dataset.ruleId = rule.id;
        row.innerHTML =
            '<input type="text" class="zhihu-kw-find" placeholder="查找关键词" value="' + escapeAttr(rule.find) + '">' +
            '<span style="color:#999;font-size:12px;">→</span>' +
            '<input type="text" class="zhihu-kw-replace" placeholder="替换为" value="' + escapeAttr(rule.replace) + '">' +
            '<label><input type="checkbox" class="zhihu-kw-regex"' + (rule.isRegex ? " checked" : "") + '>正则</label>' +
            '<label><input type="checkbox" class="zhihu-kw-rule-enabled"' + (rule.enabled ? " checked" : "") + '>启用</label>' +
            '<button class="zhihu-kw-rule-delete" title="删除规则">&times;</button>';
        return row;
    }

    function renderGroupSelector() {
        var select = document.getElementById("zhihu-kw-group-select");
        if (!select) return;

        var groups = loadGroups();
        var activeId = getActiveGroupId();
        select.innerHTML = "";

        for (var i = 0; i < groups.length; i++) {
            var option = document.createElement("option");
            option.value = groups[i].id;
            option.textContent = groups[i].name + (groups[i].authors ? " [" + truncate(groups[i].authors, 20) + "]" : " (全局)");
            if (groups[i].id === activeId) option.selected = true;
            select.appendChild(option);
        }

        updateDeleteButton(groups.length);
    }

    function renderGroupMeta() {
        var group = loadGroup(getActiveGroupId());
        if (!group) return;

        var nameInput = document.getElementById("zhihu-kw-group-name");
        var authorsInput = document.getElementById("zhihu-kw-group-authors");
        if (nameInput) nameInput.value = group.name;
        if (authorsInput) authorsInput.value = group.authors;
    }

    function renderRules() {
        var group = loadGroup(getActiveGroupId());
        var list = document.getElementById("zhihu-kw-rules-list");
        if (!list || !group) return;

        list.innerHTML = "";
        for (var i = 0; i < group.rules.length; i++) {
            list.appendChild(createRuleRow(group.rules[i]));
        }
    }

    function renderAll() {
        renderGroupSelector();
        renderGroupMeta();
        renderRules();
    }

    function collectRulesFromUI() {
        var rows = document.querySelectorAll("#zhihu-kw-rules-list .zhihu-kw-rule-row");
        var rules = [];
        var nextId = 1;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var findEl = row.querySelector(".zhihu-kw-find");
            var replaceEl = row.querySelector(".zhihu-kw-replace");
            var regexEl = row.querySelector(".zhihu-kw-regex");
            var enabledEl = row.querySelector(".zhihu-kw-rule-enabled");
            if (!findEl) continue;
            rules.push({
                id: nextId++,
                find: findEl.value,
                replace: replaceEl ? replaceEl.value : "",
                isRegex: regexEl ? regexEl.checked : false,
                enabled: enabledEl ? enabledEl.checked : true,
            });
        }
        return rules;
    }

    function collectGroupMetaFromUI() {
        var nameInput = document.getElementById("zhihu-kw-group-name");
        var authorsInput = document.getElementById("zhihu-kw-group-authors");
        return {
            name: nameInput ? nameInput.value.trim() : "未命名",
            authors: authorsInput ? authorsInput.value.trim() : "",
        };
    }

    function updateDeleteButton(groupCount) {
        var btn = document.getElementById("zhihu-kw-group-delete");
        if (btn) {
            btn.disabled = groupCount <= 1;
        }
    }

    function truncate(s, maxLen) {
        return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
    }

    // ---- UI 事件 ----

    var panelVisible = false;

    function togglePanel() {
        panelVisible = !panelVisible;
        var overlay = document.getElementById("zhihu-kw-panel-overlay");
        if (!overlay) return;

        if (panelVisible) {
            overlay.style.display = "flex";
            renderAll();
            document.getElementById("zhihu-kw-enabled-check").checked = isEnabled();
        } else {
            overlay.style.display = "none";
        }
    }

    function closePanel() {
        panelVisible = false;
        var overlay = document.getElementById("zhihu-kw-panel-overlay");
        if (overlay) overlay.style.display = "none";
    }

    function switchGroup(groupId) {
        setActiveGroupId(groupId);
        renderAll();
    }

    function createNewGroup() {
        var newGroup = {
            id: makeGroupId(),
            name: "新建规则组",
            authors: "",
            rules: [{ id: 1, find: "", replace: "", isRegex: false, enabled: true }],
        };
        var groups = loadGroups();
        groups.push(newGroup);
        saveGroups(groups);
        setActiveGroupId(newGroup.id);
        renderAll();
    }

    function deleteCurrentGroup() {
        var groups = loadGroups();
        if (groups.length <= 1) {
            alert("至少保留一个规则组");
            return;
        }

        var activeId = getActiveGroupId();
        var idx = -1;
        for (var i = 0; i < groups.length; i++) {
            if (groups[i].id === activeId) { idx = i; break; }
        }
        if (idx === -1) return;

        if (!confirm("确定删除规则组「" + groups[idx].name + "」？")) return;

        groups.splice(idx, 1);
        saveGroups(groups);
        var newActiveId = groups[Math.max(0, idx - 1)].id;
        setActiveGroupId(newActiveId);
        renderAll();
    }

    function saveCurrentGroup() {
        var groupId = getActiveGroupId();
        var groups = loadGroups();
        var group = null;
        for (var i = 0; i < groups.length; i++) {
            if (groups[i].id === groupId) { group = groups[i]; break; }
        }
        if (!group) return;

        var meta = collectGroupMetaFromUI();
        group.name = meta.name || "未命名";
        group.authors = meta.authors;
        group.rules = collectRulesFromUI();
        saveGroups(groups);
    }

    function saveAllAndApply() {
        // 先保存当前正在编辑的组
        saveCurrentGroup();

        var data = loadData();
        var enabledCheck = document.getElementById("zhihu-kw-enabled-check");
        data.enabled = enabledCheck ? enabledCheck.checked : true;
        saveData(data);

        updateToggleButton(data.enabled);

        if (data.enabled) {
            processAllContent();
        }

        closePanel();
    }

    function resetAll() {
        if (!confirm("确定要重置所有规则组和规则为默认状态吗？此操作不可恢复。")) return;

        var defaults = getDefaultData();
        saveData(defaults);
        renderAll();
        document.getElementById("zhihu-kw-enabled-check").checked = true;
        updateToggleButton(true);
    }

    function toggleEnabledFromMenu() {
        var enabled = !isEnabled();
        setEnabled(enabled);
        updateToggleButton(enabled);
        if (enabled) {
            processAllContent();
        } else {
            location.reload();
        }
    }

    // ---- UI 初始化 ----

    function setupUI() {
        injectStyles();

        var temp = document.createElement("div");
        temp.innerHTML = PANEL_HTML;
        while (temp.firstChild) {
            document.body.appendChild(temp.firstChild);
        }

        // 事件绑定
        document.getElementById("zhihu-kw-toggle-btn").addEventListener("click", togglePanel);
        document.getElementById("zhihu-kw-panel-close").addEventListener("click", closePanel);
        document.getElementById("zhihu-kw-panel-overlay").addEventListener("click", function (e) {
            if (e.target === this) closePanel();
        });

        document.getElementById("zhihu-kw-group-select").addEventListener("change", function () {
            switchGroup(this.value);
        });

        document.getElementById("zhihu-kw-group-new").addEventListener("click", createNewGroup);
        document.getElementById("zhihu-kw-group-delete").addEventListener("click", deleteCurrentGroup);

        document.getElementById("zhihu-kw-add-rule").addEventListener("click", function () {
            saveCurrentGroup(); // 先把当前UI的规则写回 group
            var group = loadGroup(getActiveGroupId());
            if (!group) return;
            var maxId = 0;
            for (var i = 0; i < group.rules.length; i++) {
                if (group.rules[i].id > maxId) maxId = group.rules[i].id;
            }
            group.rules.push({ id: maxId + 1, find: "", replace: "", isRegex: false, enabled: true });
            saveCurrentGroup();
            renderRules();
        });

        document.getElementById("zhihu-kw-btn-save").addEventListener("click", saveAllAndApply);
        document.getElementById("zhihu-kw-btn-reset").addEventListener("click", resetAll);

        // 规则列表事件委托
        var rulesList = document.getElementById("zhihu-kw-rules-list");
        if (rulesList) {
            rulesList.addEventListener("click", function (e) {
                if (e.target.classList.contains("zhihu-kw-rule-delete")) {
                    e.target.closest(".zhihu-kw-rule-row").remove();
                }
            });
        }

        // 组名/作者输入变化时自动暂存到内存
        var groupNameInput = document.getElementById("zhihu-kw-group-name");
        var groupAuthorsInput = document.getElementById("zhihu-kw-group-authors");
        if (groupNameInput) {
            groupNameInput.addEventListener("change", function () {
                saveCurrentGroup();
                renderGroupSelector();
            });
        }
        if (groupAuthorsInput) {
            groupAuthorsInput.addEventListener("change", function () {
                saveCurrentGroup();
                renderGroupSelector();
            });
        }

        updateToggleButton(isEnabled());

        // Tampermonkey 菜单
        GM_registerMenuCommand("管理关键词替换规则", togglePanel);
        GM_registerMenuCommand("切换启用/禁用", toggleEnabledFromMenu);

        // 初始渲染
        renderAll();
    }

    function updateToggleButton(enabled) {
        var btn = document.getElementById("zhihu-kw-toggle-btn");
        if (btn) {
            btn.classList.toggle("disabled", !enabled);
        }
    }

    // ============================================================
    // 初始化
    // ============================================================
    function init() {
        setupUI();

        if (isEnabled()) {
            processAllContent();
            setupObserver();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
