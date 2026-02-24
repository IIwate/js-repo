// ==UserScript==
// @name         VNDB 增强脚本
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  悬浮快捷按钮：愿望单/黑名单/当前页批量拉黑 (API版)
// @author       iiwate
// @match        https://vndb.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      api.vndb.org
// @icon         https://vndb.org/favicon.ico
// @run-at       document-idle
// @license MIT
// ==/UserScript==

(function() {
    'use strict';

    const API_TOKEN_KEY = 'vndb_api_token';
    const SETTINGS_KEY = 'vndb_quick_actions_settings';
    const LIST_DIRTY_TS_KEY = 'vndb_list_dirty_ts';
    const LABEL_WISHLIST = 5;
    const LABEL_BLACKLIST = 6;

    const UI_STYLE_ID = 'vndb-floating-actions-style';
    const UI_CONTAINER_ID = 'vndb-floating-actions';
    const BTN_SETTINGS_ID = 'vndb-fab-settings';
    const BTN_BULK_BLACKLIST_ID = 'vndb-fab-bulk-blacklist';
    const BTN_STOP_BULK_ID = 'vndb-fab-stop-bulk';
    const BTN_WISHLIST_ID = 'vndb-fab-wishlist';
    const BTN_BLACKLIST_ID = 'vndb-fab-blacklist';
    const BTN_TOP_ID = 'vndb-fab-top';
    const TOAST_ID = 'vndb-fab-toast';
    const SETTINGS_MODAL_ID = 'vndb-fab-settings-modal';

    const DEFAULT_SETTINGS = Object.freeze({
        concurrency: 1,
        intervalMs: 500,
        retryCount: 2,
        autoRefresh: true,
        openInNewTab: true,
        keepCurrentPage: true
    });

    const isVNListPage = () => /^\/v\/?$/.test(location.pathname);
    const isVNDetailPage = () => /^\/v\d+(?:\/chars)?\/?$/.test(location.pathname);
    const getVNIdFromPath = () => location.pathname.match(/^\/v(\d+)/)?.[1] || null;

    let apiToken = loadTokenFromStorage();
    let settings = loadSettings();
    let isBulkRunning = false;
    let bulkAbortRequested = false;
    let detailState = {
        wishlist: false,
        blacklist: false
    };
    let detailActionInFlight = false;
    let listLinkInterceptorBound = false;
    let listRefreshHandlersBound = false;
    let sharedStateSyncBound = false;
    let lastSeenDirtyTs = 0;

    const ui = {
        container: null,
        settingsBtn: null,
        bulkBlacklistBtn: null,
        stopBulkBtn: null,
        wishlistBtn: null,
        blacklistBtn: null,
        topBtn: null,
        settingsModal: null
    };

    function parseSettingsFromRaw(raw) {
        if (!raw) return { ...DEFAULT_SETTINGS };
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                concurrency: clampInt(parsed.concurrency, 1, 5, DEFAULT_SETTINGS.concurrency),
                intervalMs: clampInt(parsed.intervalMs, 100, 10000, DEFAULT_SETTINGS.intervalMs),
                retryCount: clampInt(parsed.retryCount, 0, 5, DEFAULT_SETTINGS.retryCount),
                autoRefresh: Boolean(parsed.autoRefresh),
                openInNewTab: parsed.openInNewTab === undefined ? DEFAULT_SETTINGS.openInNewTab : Boolean(parsed.openInNewTab),
                keepCurrentPage: parsed.keepCurrentPage === undefined ? DEFAULT_SETTINGS.keepCurrentPage : Boolean(parsed.keepCurrentPage)
            };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function parsePositiveInt(value, fallback = 0) {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function clearStoredToken() {
        apiToken = '';
        GM_setValue(API_TOKEN_KEY, '');
    }

    function loadTokenFromStorage() {
        const tokenValue = GM_getValue(API_TOKEN_KEY, '');
        return typeof tokenValue === 'string' ? tokenValue : '';
    }

    function saveStoredToken(tokenValue) {
        const normalized = String(tokenValue || '').trim();
        if (!normalized) {
            clearStoredToken();
            return;
        }
        apiToken = normalized;
        GM_setValue(API_TOKEN_KEY, normalized);
    }

    function loadSettings() {
        const raw = GM_getValue(SETTINGS_KEY, '');
        return parseSettingsFromRaw(raw);
    }

    function saveSettings(next) {
        settings = {
            concurrency: clampInt(next.concurrency, 1, 5, DEFAULT_SETTINGS.concurrency),
            intervalMs: clampInt(next.intervalMs, 100, 10000, DEFAULT_SETTINGS.intervalMs),
            retryCount: clampInt(next.retryCount, 0, 5, DEFAULT_SETTINGS.retryCount),
            autoRefresh: Boolean(next.autoRefresh),
            openInNewTab: Boolean(next.openInNewTab),
            keepCurrentPage: Boolean(next.keepCurrentPage)
        };
        GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    }

    function syncRuntimeStateFromStorage() {
        settings = loadSettings();
        apiToken = loadTokenFromStorage();
    }

    function handleRuntimeStateVisibilitySync() {
        if (document.visibilityState !== 'visible') return;
        syncRuntimeStateFromStorage();
    }

    function ensureRuntimeStateSync() {
        if (sharedStateSyncBound) return;
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(SETTINGS_KEY, (_key, _oldValue, newValue) => {
                settings = parseSettingsFromRaw(newValue);
            });
            GM_addValueChangeListener(API_TOKEN_KEY, () => {
                apiToken = loadTokenFromStorage();
            });
            GM_addValueChangeListener(LIST_DIRTY_TS_KEY, (_key, _oldValue, newValue) => {
                const dirtyTs = parsePositiveInt(newValue, 0);
                if (dirtyTs <= lastSeenDirtyTs) return;
                maybeRefreshListForDirtyData();
            });
        }
        window.addEventListener('focus', syncRuntimeStateFromStorage);
        document.addEventListener('visibilitychange', handleRuntimeStateVisibilitySync);
        sharedStateSyncBound = true;
    }

    function clampInt(value, min, max, fallback) {
        const n = Number.parseInt(String(value), 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function normalizeVNId(vnId) {
        return String(vnId).replace(/^v/i, '');
    }

    function parseVNIdFromHref(href) {
        const raw = String(href || '');
        if (!raw) return null;
        const directMatch = raw.match(/^\/v(\d+)$/i);
        if (directMatch) return `v${directMatch[1]}`;
        try {
            const url = new URL(raw, location.origin);
            if (url.origin !== location.origin) return null;
            const match = url.pathname.match(/^\/v(\d+)$/i);
            return match ? `v${match[1]}` : null;
        } catch {
            return null;
        }
    }

    function showToast(message, duration = 2200) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), duration);
    }

    function promptForTokenIfMissing() {
        apiToken = loadTokenFromStorage();
        if (apiToken && apiToken.trim()) return true;
        showToast('请先在设置中填写 Token');
        openSettingsModal();
        return false;
    }

    function ensureStyle() {
        if (document.getElementById(UI_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = UI_STYLE_ID;
        style.textContent = `
#${UI_CONTAINER_ID} {
    position: fixed;
    right: 18px;
    bottom: 96px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
#${UI_CONTAINER_ID} .vndb-fab-btn {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #fff;
    background: #5f6670;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1;
    user-select: none;
    white-space: nowrap;
    transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
}
#${UI_CONTAINER_ID} .vndb-fab-btn:hover {
    transform: translateY(-2px);
    background: #6a727d;
}
#${UI_CONTAINER_ID} .vndb-fab-btn:disabled {
    cursor: not-allowed;
    opacity: 0.65;
    transform: none;
}
#${UI_CONTAINER_ID} .vndb-fab-btn.is-active {
    background: #c94848;
}
#${UI_CONTAINER_ID} .vndb-fab-btn.vndb-fab-wishlist.is-active {
    background: #d7a631;
    border-color: rgba(255, 255, 255, 0.28);
}
#${UI_CONTAINER_ID} .vndb-fab-btn.vndb-fab-blacklist.is-active {
    background: #c94848;
    border-color: rgba(255, 255, 255, 0.28);
}
#${UI_CONTAINER_ID} .vndb-fab-btn.hidden {
    display: none;
}
#${UI_CONTAINER_ID} .vndb-fab-btn.vndb-fab-stop {
    background: #9f3a3a;
}
#${UI_CONTAINER_ID} .vndb-fab-btn.vndb-fab-stop:disabled {
    background: #616161;
}
#${TOAST_ID} {
    position: fixed;
    right: 24px;
    bottom: 30px;
    z-index: 2147483647;
    max-width: 280px;
    padding: 10px 12px;
    color: #fff;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.84);
    font-size: 13px;
    line-height: 1.4;
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.15s ease, transform 0.15s ease;
}
#${TOAST_ID}.show {
    opacity: 1;
    transform: translateY(0);
}
#${SETTINGS_MODAL_ID} {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: none;
    align-items: center;
    justify-content: center;
}
#${SETTINGS_MODAL_ID}.show {
    display: flex;
}
#${SETTINGS_MODAL_ID} .vndb-settings-mask {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
}
#${SETTINGS_MODAL_ID} .vndb-settings-panel {
    position: relative;
    width: min(440px, calc(100vw - 28px));
    max-height: calc(100vh - 40px);
    overflow: auto;
    border-radius: 12px;
    background: #0f253a;
    color: #eaf3ff;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.45);
    padding: 18px 16px 14px;
}
#${SETTINGS_MODAL_ID} .vndb-settings-title {
    margin: 0 0 14px;
    font-size: 18px;
    font-weight: 700;
}
#${SETTINGS_MODAL_ID} .vndb-settings-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
}
#${SETTINGS_MODAL_ID} label {
    font-size: 13px;
    opacity: 0.95;
}
#${SETTINGS_MODAL_ID} input[type="text"],
#${SETTINGS_MODAL_ID} input[type="password"],
#${SETTINGS_MODAL_ID} input[type="number"] {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
}
#${SETTINGS_MODAL_ID} .vndb-settings-hint {
    margin: 2px 0 0;
    font-size: 12px;
    opacity: 0.7;
}
#${SETTINGS_MODAL_ID} .vndb-settings-checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
}
#${SETTINGS_MODAL_ID} .vndb-settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
}
#${SETTINGS_MODAL_ID} .vndb-settings-actions button {
    border: 0;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
}
#${SETTINGS_MODAL_ID} .vndb-btn-cancel {
    background: #5a6572;
    color: #fff;
}
#${SETTINGS_MODAL_ID} .vndb-btn-save {
    background: #2d8cff;
    color: #fff;
}
@media (max-width: 900px) {
    #${UI_CONTAINER_ID} {
        right: 12px;
        bottom: 82px;
        gap: 8px;
    }
    #${UI_CONTAINER_ID} .vndb-fab-btn {
        width: 48px;
        height: 48px;
        font-size: 12px;
    }
}
        `;
        document.head.appendChild(style);
    }

    function setFabButtonDisplay(btn, label) {
        if (!btn) return;
        btn.textContent = label;
    }

    function makeButton(id, label, title, onClick) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.type = 'button';
        btn.className = 'vndb-fab-btn';
        btn.title = title;
        setFabButtonDisplay(btn, label);
        btn.addEventListener('click', onClick);
        return btn;
    }

    function ensureSettingsModal() {
        if (ui.settingsModal && document.body.contains(ui.settingsModal)) return;
        const modal = document.createElement('div');
        modal.id = SETTINGS_MODAL_ID;
        modal.innerHTML = `
<div class="vndb-settings-mask" data-close="1"></div>
<div class="vndb-settings-panel" role="dialog" aria-modal="true">
    <h3 class="vndb-settings-title">VNDB 快捷操作设置</h3>
    <div class="vndb-settings-row">
        <label for="vndb-setting-token">API Token</label>
        <input id="vndb-setting-token" type="password" autocomplete="off" />
        <p class="vndb-settings-hint">留空表示不修改；输入 !clear 可清空。</p>
    </div>
    <div class="vndb-settings-row">
        <label for="vndb-setting-concurrency">并发数 (1-5)</label>
        <input id="vndb-setting-concurrency" type="number" min="1" max="5" />
    </div>
    <div class="vndb-settings-row">
        <label for="vndb-setting-interval">请求间隔毫秒 (100-10000)</label>
        <input id="vndb-setting-interval" type="number" min="100" max="10000" />
    </div>
    <div class="vndb-settings-row">
        <label for="vndb-setting-retry">失败重试次数 (0-5)</label>
        <input id="vndb-setting-retry" type="number" min="0" max="5" />
    </div>
    <div class="vndb-settings-row vndb-settings-checkbox">
        <input id="vndb-setting-refresh" type="checkbox" />
        <label for="vndb-setting-refresh">批量完成后自动刷新</label>
    </div>
    <div class="vndb-settings-row vndb-settings-checkbox">
        <input id="vndb-setting-open-new-tab" type="checkbox" />
        <label for="vndb-setting-open-new-tab">作品新标签页打开</label>
    </div>
    <div class="vndb-settings-row vndb-settings-checkbox" id="vndb-setting-keep-current-row">
        <input id="vndb-setting-keep-current" type="checkbox" />
        <label for="vndb-setting-keep-current">打开后停留当前页</label>
    </div>
    <div class="vndb-settings-actions">
        <button type="button" class="vndb-btn-cancel" data-close="1">取消</button>
        <button type="button" class="vndb-btn-save" id="vndb-setting-save">保存</button>
    </div>
</div>
        `;
        document.body.appendChild(modal);
        ui.settingsModal = modal;

        modal.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[data-close="1"]')) {
                closeSettingsModal();
            }
        });

        const saveBtn = modal.querySelector('#vndb-setting-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveSettingsFromModal);
        }
        const openNewTabInput = modal.querySelector('#vndb-setting-open-new-tab');
        if (openNewTabInput) {
            openNewTabInput.addEventListener('change', syncNewTabSubOptionVisibility);
        }

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && ui.settingsModal?.classList.contains('show')) {
                closeSettingsModal();
            }
        });
    }

    function syncNewTabSubOptionVisibility() {
        const modal = ui.settingsModal;
        if (!modal) return;
        const openNewTabInput = modal.querySelector('#vndb-setting-open-new-tab');
        const keepCurrentInput = modal.querySelector('#vndb-setting-keep-current');
        const keepCurrentRow = modal.querySelector('#vndb-setting-keep-current-row');
        const isParentEnabled = Boolean(openNewTabInput && openNewTabInput.checked);
        if (keepCurrentRow) {
            keepCurrentRow.style.display = isParentEnabled ? 'flex' : 'none';
        }
        if (keepCurrentInput) {
            keepCurrentInput.disabled = !isParentEnabled;
        }
    }

    function fillSettingsModalFields() {
        ensureSettingsModal();
        const modal = ui.settingsModal;
        if (!modal) return;
        const tokenInput = modal.querySelector('#vndb-setting-token');
        const concurrencyInput = modal.querySelector('#vndb-setting-concurrency');
        const intervalInput = modal.querySelector('#vndb-setting-interval');
        const retryInput = modal.querySelector('#vndb-setting-retry');
        const refreshInput = modal.querySelector('#vndb-setting-refresh');
        const openNewTabInput = modal.querySelector('#vndb-setting-open-new-tab');
        const keepCurrentInput = modal.querySelector('#vndb-setting-keep-current');
        if (tokenInput) tokenInput.value = '';
        if (concurrencyInput) concurrencyInput.value = String(settings.concurrency);
        if (intervalInput) intervalInput.value = String(settings.intervalMs);
        if (retryInput) retryInput.value = String(settings.retryCount);
        if (refreshInput) refreshInput.checked = settings.autoRefresh;
        if (openNewTabInput) openNewTabInput.checked = settings.openInNewTab;
        if (keepCurrentInput) keepCurrentInput.checked = settings.keepCurrentPage;
        syncNewTabSubOptionVisibility();
    }

    function openSettingsModal() {
        fillSettingsModalFields();
        ui.settingsModal?.classList.add('show');
    }

    function closeSettingsModal() {
        ui.settingsModal?.classList.remove('show');
    }

    function saveSettingsFromModal() {
        const modal = ui.settingsModal;
        if (!modal) return;
        const tokenInput = modal.querySelector('#vndb-setting-token');
        const concurrencyInput = modal.querySelector('#vndb-setting-concurrency');
        const intervalInput = modal.querySelector('#vndb-setting-interval');
        const retryInput = modal.querySelector('#vndb-setting-retry');
        const refreshInput = modal.querySelector('#vndb-setting-refresh');
        const openNewTabInput = modal.querySelector('#vndb-setting-open-new-tab');
        const keepCurrentInput = modal.querySelector('#vndb-setting-keep-current');

        const tokenValue = tokenInput && 'value' in tokenInput ? String(tokenInput.value || '').trim() : '';
        if (tokenValue === '!clear') {
            clearStoredToken();
        } else if (tokenValue) {
            saveStoredToken(tokenValue);
        }

        const next = {
            concurrency: clampInt(concurrencyInput && 'value' in concurrencyInput ? concurrencyInput.value : settings.concurrency, 1, 5, settings.concurrency),
            intervalMs: clampInt(intervalInput && 'value' in intervalInput ? intervalInput.value : settings.intervalMs, 100, 10000, settings.intervalMs),
            retryCount: clampInt(retryInput && 'value' in retryInput ? retryInput.value : settings.retryCount, 0, 5, settings.retryCount),
            autoRefresh: Boolean(refreshInput && 'checked' in refreshInput ? refreshInput.checked : settings.autoRefresh),
            openInNewTab: Boolean(openNewTabInput && 'checked' in openNewTabInput ? openNewTabInput.checked : settings.openInNewTab),
            keepCurrentPage: Boolean(keepCurrentInput && 'checked' in keepCurrentInput ? keepCurrentInput.checked : settings.keepCurrentPage)
        };
        saveSettings(next);
        closeSettingsModal();
        showToast('设置已保存');
    }

    function ensureUI() {
        ensureStyle();
        if (ui.container && document.body.contains(ui.container)) return;
        const container = document.createElement('div');
        container.id = UI_CONTAINER_ID;

        ui.settingsBtn = makeButton(BTN_SETTINGS_ID, '设置', '设置 Token 与批量参数', handleSettings);
        ui.bulkBlacklistBtn = makeButton(BTN_BULK_BLACKLIST_ID, '拉黑', '拉黑当前分页可见作品', handleBulkBlacklist);
        ui.stopBulkBtn = makeButton(BTN_STOP_BULK_ID, '停止', '停止当前批量任务', handleStopBulk);
        ui.stopBulkBtn.classList.add('vndb-fab-stop');
        ui.stopBulkBtn.disabled = true;
        ui.wishlistBtn = makeButton(BTN_WISHLIST_ID, '愿望单', '加入/移出愿望单', handleWishlistToggle);
        ui.wishlistBtn.classList.add('vndb-fab-wishlist');
        ui.blacklistBtn = makeButton(BTN_BLACKLIST_ID, '黑名单', '加入/移出黑名单', handleBlacklistToggle);
        ui.blacklistBtn.classList.add('vndb-fab-blacklist');
        ui.topBtn = makeButton(BTN_TOP_ID, '顶部', '返回顶部', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        container.appendChild(ui.settingsBtn);
        container.appendChild(ui.bulkBlacklistBtn);
        container.appendChild(ui.stopBulkBtn);
        container.appendChild(ui.wishlistBtn);
        container.appendChild(ui.blacklistBtn);
        container.appendChild(ui.topBtn);
        document.body.appendChild(container);
        ui.container = container;
        ensureSettingsModal();
    }

    function setButtonVisible(btn, visible) {
        if (!btn) return;
        btn.classList.toggle('hidden', !visible);
    }

    function applyRouteVisibility() {
        ensureUI();
        const inList = isVNListPage();
        const inDetail = isVNDetailPage();
        const shouldShow = inList || inDetail;
        ui.container.style.display = shouldShow ? 'flex' : 'none';
        setButtonVisible(ui.settingsBtn, shouldShow);
        setButtonVisible(ui.topBtn, shouldShow);
        setButtonVisible(ui.bulkBlacklistBtn, inList);
        setButtonVisible(ui.stopBulkBtn, inList);
        setButtonVisible(ui.wishlistBtn, inDetail);
        setButtonVisible(ui.blacklistBtn, inDetail);
        setStopButtonState(isBulkRunning);
        if (inDetail) refreshDetailState();
    }

    function isListPageVNAnchor(anchor) {
        if (!anchor) return false;
        let url;
        try {
            url = new URL(anchor.getAttribute('href') || anchor.href, location.origin);
        } catch {
            return false;
        }
        if (url.origin !== location.origin) return false;
        const path = url.pathname;
        if (!/^\/v\d+\/?$/.test(path)) return false;
        return Boolean(anchor.closest('article.vncards'));
    }

    function handleListPageVNClick(event) {
        if (!isVNListPage()) return;
        if (!settings.openInNewTab) return;
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest('a[href]');
        if (!(anchor instanceof HTMLAnchorElement)) return;
        if (anchor.target && anchor.target !== '_self') return;
        if (!isListPageVNAnchor(anchor)) return;

        let href = '';
        try {
            const url = new URL(anchor.getAttribute('href') || anchor.href, location.origin);
            if (url.origin !== location.origin) return;
            href = url.href;
        } catch {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (!openWithPreferredNewTab(href, settings.keepCurrentPage)) {
            showToast('新标签页被拦截，请允许弹窗');
        }
    }

    function openWithPreferredNewTab(href, keepCurrentPage) {
        const shouldActivateNewTab = !keepCurrentPage;

        if (typeof GM_openInTab === 'function') {
            try {
                GM_openInTab(href, {
                    active: shouldActivateNewTab,
                    insert: true,
                    setParent: true
                });
                return true;
            } catch {
                try {
                    GM_openInTab(href, shouldActivateNewTab);
                    return true;
                } catch {
                    // ignore and fallback to window.open
                }
            }
        }

        const newTab = window.open(href, '_blank', 'noopener,noreferrer');
        if (!newTab) return false;
        try {
            newTab.opener = null;
        } catch {
            // ignore
        }
        if (keepCurrentPage) {
            setTimeout(() => {
                window.focus();
            }, 20);
        }
        return true;
    }

    function ensureListLinkInterceptor() {
        if (listLinkInterceptorBound) return;
        document.addEventListener('click', handleListPageVNClick, true);
        listLinkInterceptorBound = true;
    }

    function getListDirtyTimestamp() {
        return parsePositiveInt(GM_getValue(LIST_DIRTY_TS_KEY, 0), 0);
    }

    function setListDirtyTimestamp(value) {
        GM_setValue(LIST_DIRTY_TS_KEY, parsePositiveInt(value, 0));
    }

    function markListDirtyFlag() {
        setListDirtyTimestamp(Date.now());
    }

    function maybeRefreshListForDirtyData() {
        if (!isVNListPage()) return;
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        const dirtyTs = getListDirtyTimestamp();
        if (!dirtyTs) return;
        if (dirtyTs <= lastSeenDirtyTs) return;
        lastSeenDirtyTs = dirtyTs;
        location.reload();
    }

    function isBackForwardNavigation(event) {
        const persisted = Boolean(event && event.persisted);
        if (persisted) return true;
        if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
            const navEntry = performance.getEntriesByType('navigation')[0];
            return Boolean(navEntry && navEntry.type === 'back_forward');
        }
        return false;
    }

    function handleListPageShow(event) {
        if (!isBackForwardNavigation(event)) return;
        maybeRefreshListForDirtyData();
    }

    function handleListVisibilityChange() {
        if (document.visibilityState !== 'visible') return;
        maybeRefreshListForDirtyData();
    }

    function handleListWindowFocus() {
        maybeRefreshListForDirtyData();
    }

    function syncListSeenTimestampOnInit() {
        if (!isVNListPage()) return;
        lastSeenDirtyTs = getListDirtyTimestamp();
    }

    function ensureListPageShowHandler() {
        if (listRefreshHandlersBound) return;
        window.addEventListener('pageshow', handleListPageShow);
        document.addEventListener('visibilitychange', handleListVisibilityChange);
        window.addEventListener('focus', handleListWindowFocus);
        listRefreshHandlersBound = true;
        syncListSeenTimestampOnInit();
    }

    function refreshDetailState() {
        if (!isVNDetailPage()) return;
        const form = document.querySelector('form.ulistvn');
        if (!form) return;
        const text = (form.textContent || '').toLowerCase();
        const hasWishlistIcon = Boolean(form.querySelector('abbr.icon-list-l5'));
        const hasBlacklistIcon = Boolean(form.querySelector('abbr.icon-list-l6'));
        detailState.wishlist = hasWishlistIcon || text.includes('wishlist') || text.includes('愿望单');
        detailState.blacklist = hasBlacklistIcon || text.includes('blacklist') || text.includes('黑名单');
        updateDetailButtonStyles();
    }

    function updateDetailButtonStyles() {
        if (!ui.wishlistBtn || !ui.blacklistBtn) return;
        ui.wishlistBtn.classList.toggle('is-active', detailState.wishlist);
        ui.blacklistBtn.classList.toggle('is-active', detailState.blacklist);
        setFabButtonDisplay(ui.wishlistBtn, '愿望单');
        setFabButtonDisplay(ui.blacklistBtn, '黑名单');
    }

    async function requestPatch(vnId, payload) {
        return new Promise((resolve) => {
            if (!apiToken) {
                resolve({ ok: false, retryable: false, status: 0, message: 'missing token' });
                return;
            }
            GM_xmlhttpRequest({
                method: 'PATCH',
                url: `https://api.vndb.org/kana/ulist/v${normalizeVNId(vnId)}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `token ${apiToken}`
                },
                timeout: 15000,
                data: JSON.stringify(payload),
                onload: (response) => {
                    const status = Number(response.status) || 0;
                    const ok = status >= 200 && status < 300;
                    const retryable = status === 429 || status >= 500;
                    resolve({
                        ok,
                        status,
                        retryable,
                        message: response.responseText || ''
                    });
                },
                ontimeout: () => {
                    resolve({ ok: false, retryable: true, status: 0, message: 'timeout' });
                },
                onerror: () => {
                    resolve({ ok: false, retryable: true, status: 0, message: 'network error' });
                }
            });
        });
    }

    async function patchLabelWithRetry(vnId, labelId, shouldSet) {
        const payload = shouldSet ? { labels_set: [labelId] } : { labels_unset: [labelId] };
        for (let attempt = 0; attempt <= settings.retryCount; attempt += 1) {
            const result = await requestPatch(vnId, payload);
            if (result.ok) return true;
            const canRetry = result.retryable && attempt < settings.retryCount;
            if (!canRetry) {
                console.error('[VNDB Enhance] API error:', result.status, result.message);
                return false;
            }
            const backoff = 1000 * (2 ** attempt);
            await sleep(backoff);
        }
        return false;
    }

    function extractCurrentPageEntries() {
        const articles = document.querySelectorAll('main article');
        if (!articles.length) return [];

        let bestArticle = null;
        let bestCount = 0;
        for (const article of articles) {
            const ids = new Set();
            for (const a of article.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || a.href;
                const id = parseVNIdFromHref(href);
                if (id) ids.add(id);
            }
            if (ids.size > bestCount) {
                bestCount = ids.size;
                bestArticle = article;
            }
        }
        if (!bestArticle || bestCount === 0) return [];

        const nodeLabelStateCache = new WeakMap();
        const getNodeLabelState = (node) => {
            const cached = nodeLabelStateCache.get(node);
            if (cached) return cached;
            const state = {
                isBlacklisted: (
                    Boolean(node.querySelector('abbr.icon-list-l6')) ||
                    Boolean(node.querySelector('abbr[title*="Blacklist" i]')) ||
                    Boolean(node.querySelector('abbr[title*="黑名单"]'))
                ),
                isWishlisted: (
                    Boolean(node.querySelector('abbr.icon-list-l5')) ||
                    Boolean(node.querySelector('abbr[title*="Wishlist" i]')) ||
                    Boolean(node.querySelector('abbr[title*="愿望单"]'))
                )
            };
            nodeLabelStateCache.set(node, state);
            return state;
        };

        const map = new Map();
        for (const a of bestArticle.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || a.href;
            const id = parseVNIdFromHref(href);
            if (!id) continue;

            const nearbyNodes = [
                a.closest('tr'),
                a.closest('li'),
                a.closest('div'),
                a.parentElement
            ].filter(Boolean);
            let isBlacklisted = false;
            let isWishlisted = false;
            for (const node of nearbyNodes) {
                const state = getNodeLabelState(node);
                if (state.isBlacklisted) isBlacklisted = true;
                if (state.isWishlisted) isWishlisted = true;
                if (isBlacklisted && isWishlisted) break;
            }

            if (!map.has(id)) {
                map.set(id, { id, isBlacklisted, isWishlisted });
            } else {
                if (isBlacklisted) map.get(id).isBlacklisted = true;
                if (isWishlisted) map.get(id).isWishlisted = true;
            }
        }

        return Array.from(map.values());
    }

    function summarizeEntryTargets(entries) {
        const summary = {
            targets: [],
            skippedBlacklisted: 0,
            skippedWishlistedOnly: 0,
            skipped: 0
        };
        for (const entry of entries) {
            if (entry.isBlacklisted) {
                summary.skippedBlacklisted += 1;
                continue;
            }
            if (entry.isWishlisted) {
                summary.skippedWishlistedOnly += 1;
                continue;
            }
            summary.targets.push(entry);
        }
        summary.skipped = summary.skippedBlacklisted + summary.skippedWishlistedOnly;
        return summary;
    }

    function setBulkButtonBusy(text, busy) {
        if (!ui.bulkBlacklistBtn) return;
        setFabButtonDisplay(ui.bulkBlacklistBtn, text);
        ui.bulkBlacklistBtn.disabled = busy;
    }

    function setStopButtonState(running) {
        if (!ui.stopBulkBtn) return;
        if (!running) {
            ui.stopBulkBtn.disabled = true;
            setFabButtonDisplay(ui.stopBulkBtn, '停止');
            return;
        }
        ui.stopBulkBtn.disabled = bulkAbortRequested;
        setFabButtonDisplay(ui.stopBulkBtn, bulkAbortRequested ? '停中' : '停止');
    }

    function handleStopBulk() {
        if (!isBulkRunning) {
            showToast('当前没有正在执行的批量任务');
            return;
        }
        bulkAbortRequested = true;
        setStopButtonState(true);
        showToast('已请求停止，当前请求完成后会停止');
    }

    async function handleBulkBlacklist() {
        if (!isVNListPage()) return;
        if (isBulkRunning) return;
        if (!promptForTokenIfMissing()) return;

        const entries = extractCurrentPageEntries();
        if (!entries.length) {
            alert('未找到当前分页可见作品。');
            return;
        }

        const {
            targets,
            skippedBlacklisted,
            skippedWishlistedOnly,
            skipped
        } = summarizeEntryTargets(entries);

        if (!targets.length) {
            alert(
                `当前页共 ${entries.length} 个作品，均不需要处理。\n` +
                `已在黑名单：${skippedBlacklisted}\n` +
                `在愿望单(非黑名单)：${skippedWishlistedOnly}`
            );
            return;
        }

        const confirmed = confirm(
            `准备拉黑当前分页可见作品。\n` +
            `总数：${entries.length}\n` +
            `待处理：${targets.length}\n` +
            `跳过(已黑名单)：${skippedBlacklisted}\n` +
            `跳过(愿望单)：${skippedWishlistedOnly}\n\n` +
            `继续执行吗？`
        );
        if (!confirmed) return;

        isBulkRunning = true;
        bulkAbortRequested = false;
        let completed = 0;
        let success = 0;
        let failed = 0;
        setBulkButtonBusy(`0/${targets.length}`, true);
        setStopButtonState(true);

        let cursor = 0;
        const takeNext = () => {
            if (bulkAbortRequested) return null;
            if (cursor >= targets.length) return null;
            const item = targets[cursor];
            cursor += 1;
            return item;
        };

        const workerCount = Math.max(1, Math.min(settings.concurrency, targets.length));
        const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
                const item = takeNext();
                if (!item) break;
                const ok = await patchLabelWithRetry(item.id, LABEL_BLACKLIST, true);
                if (ok) success += 1;
                else failed += 1;
                completed += 1;
                setBulkButtonBusy(`${completed}/${targets.length}`, true);
                if (settings.intervalMs > 0) {
                    let waited = 0;
                    while (waited < settings.intervalMs && !bulkAbortRequested) {
                        const step = Math.min(100, settings.intervalMs - waited);
                        await sleep(step);
                        waited += step;
                    }
                }
            }
        });

        await Promise.all(workers);

        const aborted = bulkAbortRequested;
        const unprocessed = Math.max(0, targets.length - completed);
        isBulkRunning = false;
        bulkAbortRequested = false;
        setBulkButtonBusy('拉黑', false);
        setStopButtonState(false);

        const summary =
            `当前页作品：${entries.length}\n` +
            `待处理：${targets.length}\n` +
            `跳过(已黑名单)：${skippedBlacklisted}\n` +
            `跳过(愿望单)：${skippedWishlistedOnly}\n` +
            `跳过合计：${skipped}\n` +
            `成功：${success}\n` +
            `失败：${failed}\n` +
            `未处理：${unprocessed}`;
        alert(`${aborted ? '拉黑已停止' : '拉黑完成'}\n\n${summary}`);

        if (!aborted && settings.autoRefresh) {
            location.reload();
        }
    }

    async function toggleDetailLabel(type) {
        if (!isVNDetailPage()) return;
        if (detailActionInFlight) return;
        if (!promptForTokenIfMissing()) return;
        const vnId = getVNIdFromPath();
        if (!vnId) return;

        const isWishlist = type === 'wishlist';
        const shouldSet = isWishlist ? !detailState.wishlist : !detailState.blacklist;
        const btn = isWishlist ? ui.wishlistBtn : ui.blacklistBtn;
        if (!btn) return;

        detailActionInFlight = true;
        btn.disabled = true;

        const ok = await patchLabelWithRetry(
            vnId,
            isWishlist ? LABEL_WISHLIST : LABEL_BLACKLIST,
            shouldSet
        );

        btn.disabled = false;
        detailActionInFlight = false;

        if (!ok) {
            showToast('操作失败，请稍后重试');
            return;
        }

        if (isWishlist) {
            showToast(shouldSet ? '已加入愿望单' : '已移出愿望单');
        } else {
            showToast(shouldSet ? '已加入黑名单' : '已移出黑名单');
        }
        markListDirtyFlag();
        location.reload();
    }

    function handleWishlistToggle() {
        toggleDetailLabel('wishlist');
    }

    function handleBlacklistToggle() {
        toggleDetailLabel('blacklist');
    }

    function handleSettings() {
        openSettingsModal();
    }

    function init() {
        ensureRuntimeStateSync();
        ensureUI();
        ensureListLinkInterceptor();
        ensureListPageShowHandler();
        applyRouteVisibility();
        updateDetailButtonStyles();
        if (isVNDetailPage()) {
            // 详情页用户选项区域由页面脚本异步渲染，延迟同步一次状态。
            setTimeout(refreshDetailState, 700);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
