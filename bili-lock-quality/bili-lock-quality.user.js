// ==UserScript==
// @name         B站锁定当前画质（阻止自动拉高码率试用）
// @description  仅在非会员场景拦截后台自动拉高到试用/会员画质，优先保持用户手动选择
// @namespace    local
// @version      1.1.3
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/video/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // 等待播放器与账号信息准备就绪
  let accountResolveTries = 0;
  const ACCOUNT_RESOLVE_MAX_TRIES = 30;
  const timer = setInterval(() => {
    const p = window.player;
    if (!p || !p.getQuality || !p.requestQuality) return;

    // 仅在“已登录且非会员”场景启用
    const normalizeVipFlag = (value) => {
      if (typeof value === "boolean") return value;
      const n = Number(value);
      if (Number.isFinite(n)) return n > 0;
      return null;
    };

    const detectAccountState = () => {
      try {
        const biliUser = window.__BiliUser__;
        const biliData =
          biliUser && biliUser.cache && typeof biliUser.cache === "object"
            ? biliUser.cache.data
            : null;
        if (!biliData || typeof biliData !== "object") {
          return { isLogin: null, isVip: null };
        }

        if (biliData.isLogin !== true) {
          return { isLogin: false, isVip: null };
        }

        {
          const fromVipStatus = normalizeVipFlag(biliData.vipStatus);
          if (fromVipStatus !== null) return { isLogin: true, isVip: fromVipStatus };
          const vipType = Number(biliData.vipType);
          const vipDueDate = Number(biliData.vipDueDate);
          if (Number.isFinite(vipType) && vipType > 0) {
            if (!Number.isFinite(vipDueDate)) return { isLogin: true, isVip: true };
            return { isLogin: true, isVip: vipDueDate > Date.now() };
          }
          if (Number.isFinite(vipType) && vipType === 0) return { isLogin: true, isVip: false };
        }
      } catch (_) {}
      return { isLogin: null, isVip: null };
    };

    const accountState = detectAccountState();
    const accountStateKnown =
      accountState.isLogin === false ||
      (accountState.isLogin === true && accountState.isVip !== null);
    if (!accountStateKnown && accountResolveTries < ACCOUNT_RESOLVE_MAX_TRIES) {
      accountResolveTries += 1;
      return;
    }
    clearInterval(timer);

    if (accountState.isLogin !== true) {
      console.info("[B站锁画质] 当前账号未登录或登录状态不可判定，脚本不启用。");
      return;
    }
    if (accountState.isVip !== false) {
      console.info("[B站锁画质] 当前账号为会员或会员状态不可判定，脚本不启用。");
      return;
    }

    // 记录用户近期交互，用于区分“手动切画质”与“后台自动切换”
    let lastUserIntentTs = 0;
    const USER_INTENT_WINDOW_MS = 4000;
    const markUserIntent = () => {
      lastUserIntentTs = Date.now();
    };
    document.addEventListener("pointerdown", markUserIntent, true);
    document.addEventListener("mousedown", markUserIntent, true);
    document.addEventListener("click", markUserIntent, true);
    document.addEventListener("touchstart", markUserIntent, true);
    document.addEventListener("keydown", markUserIntent, true);

    // 记录非会员场景下的“用户偏好画质”
    let preferredQ = NaN;
    const rawRequestQuality = p.requestQuality.bind(p);
    let autoUpgradeNotified = false;
    let unsupportedPreferredNotified = false;

    // 统一提取 qn，兼容数字数组与对象数组
    const extractQn = (item) => {
      const direct = Number(item);
      if (Number.isFinite(direct)) return direct;
      if (!item || typeof item !== "object") return NaN;
      const qn = Number(item.qn ?? item.quality ?? item.value ?? item.id);
      return Number.isFinite(qn) ? qn : NaN;
    };

    // 只提示一次：检测到后台尝试拉高画质
    const notifyAutoUpgradeOnce = (targetQ, source) => {
      if (autoUpgradeNotified) return;
      autoUpgradeNotified = true;
      console.warn(
        "[B站锁画质] 检测到后台尝试拉高画质，已拦截并保持锁定。",
        { source, targetQ: Number(targetQ), preferredQ }
      );
    };

    // 获取当前视频可用画质（按从高到低排序）
    const getAvailableQualities = () => {
      try {
        const list = p.getSupportedQualityList ? p.getSupportedQualityList() : [];
        const q = p.getQuality ? p.getQuality() : null;
        const qns = list.map((x) => extractQn(x)).filter((x) => Number.isFinite(x) && x > 0);
        const nowQ = Number(q && q.nowQ);
        const newQ = Number(q && q.newQ);
        const realQ = Number(q && q.realQ);
        if (Number.isFinite(nowQ) && nowQ > 0) qns.push(nowQ);
        if (Number.isFinite(newQ) && newQ > 0) qns.push(newQ);
        if (Number.isFinite(realQ) && realQ > 0) qns.push(realQ);
        return Array.from(new Set(qns)).sort((a, b) => b - a);
      } catch (_) {
        const q = p.getQuality ? p.getQuality() : null;
        const nowQ = Number(q && q.nowQ);
        const realQ = Number(q && q.realQ);
        if (Number.isFinite(nowQ) && nowQ > 0) return [nowQ];
        if (Number.isFinite(realQ) && realQ > 0) return [realQ];
        return [];
      }
    };

    // 将目标画质解析为当前视频“实际可用”的画质
    const resolveAvailableQn = (requestedQn) => {
      const requested = Number(requestedQn);
      if (!Number.isFinite(requested) || requested <= 0) return NaN;
      const available = getAvailableQualities();
      if (!available.length) return requested;
      if (available.includes(requested)) return requested;
      const lowerOrEqual = available.find((q) => q <= requested);
      if (Number.isFinite(lowerOrEqual)) return lowerOrEqual;
      return available[available.length - 1];
    };

    // 判断是否会员/高码率档（用于拦截自动拉升）
    const isVipLikeQn = (qn) => {
      qn = Number(qn);
      if (!Number.isFinite(qn) || qn <= 0) return false;
      try {
        const list = p.getSupportedQualityList ? p.getSupportedQualityList() : [];
        const hit = list.find((x) => extractQn(x) === qn);
        const desc = String((hit && (hit.desc || hit.name)) || "");
        // getSupportedQualityList 可能只返回数字数组，此时没有 needVip/desc 元信息
        if (hit && typeof hit === "object") {
          if (hit.needVip) return true;
          if (/大会员|高码率|4K|杜比/i.test(desc)) return true;
        }
        return qn >= 112;
      } catch (_) {
        return qn >= 112;
      }
    };

    // 非会员可选画质（排除会员/高码率档）
    const getFreeQualities = () =>
      getAvailableQualities().filter((qn) => Number.isFinite(qn) && qn > 0 && !isVipLikeQn(qn));

    const getMaxFreeQn = () => {
      const free = getFreeQualities();
      return free.length ? free[0] : NaN;
    };

    const resolveFreeQn = (requestedQn) => {
      const requested = Number(requestedQn);
      if (!Number.isFinite(requested) || requested <= 0) return NaN;
      const free = getFreeQualities();
      if (!free.length) return NaN;
      if (free.includes(requested)) return requested;
      const lowerOrEqual = free.find((q) => q <= requested);
      if (Number.isFinite(lowerOrEqual)) return lowerOrEqual;
      return free[free.length - 1];
    };

    // 初始化偏好画质：优先当前实际画质，拿不到时用“非会员最高可选”
    preferredQ = resolveFreeQn(
      (() => {
        const q = p.getQuality ? p.getQuality() : null;
        const nowQ = Number(q && q.nowQ);
        const realQ = Number(q && q.realQ);
        const newQ = Number(q && q.newQ);
        if (Number.isFinite(realQ) && realQ > 0 && !isVipLikeQn(realQ)) return realQ;
        if (Number.isFinite(nowQ) && nowQ > 0 && !isVipLikeQn(nowQ)) return nowQ;
        if (Number.isFinite(newQ) && newQ > 0 && !isVipLikeQn(newQ)) return newQ;
        return getMaxFreeQn();
      })()
    );

    // 安全请求：避免重复请求同画质导致 Promise 拒绝刷屏
    let requestInFlight = false;
    let lastEnforceTs = 0;
    const ENFORCE_COOLDOWN_MS = 1200;
    const safeRequestQuality = (qn, ...args) => {
      const desiredQ = resolveAvailableQn(qn);
      if (!Number.isFinite(desiredQ) || desiredQ <= 0) {
        return Promise.resolve();
      }
      const cur = p.getQuality ? p.getQuality() : null;
      const nowQ = cur ? Number(cur.nowQ) : NaN;
      if (nowQ === desiredQ) {
        return Promise.resolve();
      }
      if (requestInFlight) return Promise.resolve();
      requestInFlight = true;
      return Promise.resolve(rawRequestQuality(desiredQ, ...args))
        .catch(() => {})
        .finally(() => {
          requestInFlight = false;
        });
    };

    // 劫持 requestQuality，拦截自动升到试用/会员档
    p.requestQuality = function (qn, ...args) {
      const requestedQ = Number(qn);
      const isUserInitiated = Date.now() - lastUserIntentTs <= USER_INTENT_WINDOW_MS;
      const resolvedRequestedQ = resolveAvailableQn(requestedQ);
      const requestedVipLike = isVipLikeQn(requestedQ);
      const maxFreeQ = getMaxFreeQn();
      const fallbackQ = Number.isFinite(resolveFreeQn(preferredQ))
        ? resolveFreeQn(preferredQ)
        : maxFreeQ;

      // 普通档位：允许切换；仅当近期有交互时才更新用户偏好
      if (!requestedVipLike) {
        if (isUserInitiated) {
          preferredQ = resolveFreeQn(resolvedRequestedQ);
          autoUpgradeNotified = false;
          unsupportedPreferredNotified = false;
          console.log("[B站锁画质] 检测到手动改档，已更新偏好画质。", {
            requestedQ,
            preferredQ,
          });
        }
        return safeRequestQuality(resolvedRequestedQ, ...args);
      }

      // 会员/高码率档：视为后台升档，回到“用户偏好”或“非会员最高可选”
      if (requestedVipLike || (Number.isFinite(maxFreeQ) && requestedQ > maxFreeQ)) {
        notifyAutoUpgradeOnce(requestedQ, "requestQuality");
        return safeRequestQuality(fallbackQ, ...args);
      }
      return safeRequestQuality(resolvedRequestedQ, ...args);
    };

    // 屏蔽可能触发“会员试用清晰度”的内部入口
    if (typeof p.setVipQuality === "function") {
      p.setVipQuality = function () {};
    }

    // 守护：检测后台升档并回拉到偏好画质（若无偏好则回到非会员最高可选）
    setInterval(() => {
      const q = p.getQuality ? p.getQuality() : null;
      if (!q) return;

      const nowQ = Number(q.nowQ);
      const newQ = q.newQ != null ? Number(q.newQ) : NaN;
      const realQ = q.realQ != null ? Number(q.realQ) : NaN;
      const maxFreeQ = getMaxFreeQn();
      const resolvedPreferredQ = resolveFreeQn(preferredQ);
      const hasPreferredQ = Number.isFinite(resolvedPreferredQ) && resolvedPreferredQ > 0;

      if (
        Number.isFinite(preferredQ) &&
        preferredQ > 0 &&
        Number.isFinite(resolvedPreferredQ) &&
        resolvedPreferredQ > 0 &&
        resolvedPreferredQ !== preferredQ
      ) {
        preferredQ = resolvedPreferredQ;
        if (!unsupportedPreferredNotified) {
          unsupportedPreferredNotified = true;
          console.warn("[B站锁画质] 当前视频不支持所选画质，已自动降级到", preferredQ);
        }
      }

      // 播放器状态稳定后再建立偏好画质，优先沿用当前非会员画质
      if (!hasPreferredQ) {
        const bootstrapQ = [realQ, nowQ, newQ].find(
          (candidateQ) =>
            Number.isFinite(candidateQ) &&
            candidateQ > 0 &&
            !isVipLikeQn(candidateQ) &&
            (!Number.isFinite(maxFreeQ) || candidateQ <= maxFreeQ)
        );
        if (Number.isFinite(bootstrapQ)) {
          preferredQ = resolveFreeQn(bootstrapQ);
          autoUpgradeNotified = false;
          unsupportedPreferredNotified = false;
        } else if (Number.isFinite(maxFreeQ)) {
          preferredQ = resolveFreeQn(maxFreeQ);
          autoUpgradeNotified = false;
          unsupportedPreferredNotified = false;
        }
      }

      if (
        !Number.isNaN(newQ) &&
        (isVipLikeQn(newQ) || (Number.isFinite(maxFreeQ) && newQ > maxFreeQ))
      ) {
        notifyAutoUpgradeOnce(newQ, "quality-state");
      }

      // 近期有交互时，用当前非会员档位同步偏好
      const recentIntent = Date.now() - lastUserIntentTs <= USER_INTENT_WINDOW_MS;
      const intentCandidateQ = [newQ, realQ, nowQ].find(
        (candidateQ) =>
          Number.isFinite(candidateQ) &&
          candidateQ > 0 &&
          !isVipLikeQn(candidateQ) &&
          (!Number.isFinite(maxFreeQ) || candidateQ <= maxFreeQ)
      );
      if (
        recentIntent &&
        Number.isFinite(intentCandidateQ) &&
        intentCandidateQ !== preferredQ
      ) {
        preferredQ = resolveFreeQn(intentCandidateQ);
        autoUpgradeNotified = false;
        unsupportedPreferredNotified = false;
      }

      const currentQ =
        Number.isFinite(realQ) && realQ > 0 ? realQ : Number.isFinite(nowQ) ? nowQ : NaN;
      const fallbackQ = Number.isFinite(resolveFreeQn(preferredQ))
        ? resolveFreeQn(preferredQ)
        : maxFreeQ;
      const shouldRollback =
        Number.isFinite(currentQ) &&
        Number.isFinite(fallbackQ) &&
        currentQ !== fallbackQ &&
        (isVipLikeQn(currentQ) || (Number.isFinite(maxFreeQ) && currentQ > maxFreeQ));

      if (
        shouldRollback
      ) {
        const ts = Date.now();
        if (ts - lastEnforceTs >= ENFORCE_COOLDOWN_MS) {
          lastEnforceTs = ts;
          safeRequestQuality(fallbackQ);
        }
      }
    }, 500);

    // 预留手动切换偏好画质接口（F12里可调用）
    window.biliLockQuality = (qn) => {
      preferredQ = resolveFreeQn(qn);
      const fallbackQ = Number.isFinite(resolveFreeQn(preferredQ))
        ? resolveFreeQn(preferredQ)
        : getMaxFreeQn();
      autoUpgradeNotified = false;
      unsupportedPreferredNotified = false;
      safeRequestQuality(fallbackQ);
      console.log("[B站锁画质] 已改为", fallbackQ);
    };
  }, 300);
})();
