# B站锁定当前画质

Tampermonkey 油猴脚本，专为**非会员用户**设计。阻止 B 站播放器后台自动将画质拉升到会员/试用档位（如 4K、杜比、高码率等），保持用户手动选择的画质不被覆盖。

## 功能

- 自动检测账号状态，仅在「已登录 + 非会员」时启用
- 拦截播放器内部的 `requestQuality` 调用，阻止自动升档到会员画质
- 屏蔽 `setVipQuality` 等可能触发试用清晰度的入口
- 每 500ms 守护检查，发现画质被偷偷拉高时自动回退
- 用户手动切换画质时正常放行，并记住偏好
- 当前视频不支持偏好画质时自动降级到最近可用档

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 新建脚本，将 `bili-lock-quality.user.js` 的内容粘贴进去并保存
3. 打开 B 站视频或番剧页面，脚本自动生效

## 生效页面

- `https://www.bilibili.com/video/*`
- `https://www.bilibili.com/bangumi/play/*`

## 控制台接口

在浏览器 F12 控制台中可手动切换偏好画质：

```js
// 参数为画质代号，如 80 = 1080P, 64 = 720P, 32 = 480P, 16 = 360P
biliLockQuality(80)
```
