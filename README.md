# 携程机票价格监控

监控泉州晋江国际机场 `JJN` 到成都天府国际机场 `TFU`，`2026-08-09` 深圳航空 `ZH9494` 的最低机票价格，并通过 Bark 推送运行结果。

## Arcadia 环境变量

必需：

- `BARK`: Bark key。不要写进源码。

可选：

- `CTRIP_FLIGHT_URL`: 携程航班列表 URL，默认已配置为本次监控链接。
- `TARGET_FLIGHT_NO`: 目标航班号，默认 `ZH9494`。
- `PRICE_STATE_FILE`: 价格状态文件路径，默认 `data/last-price.json`。
- `BARK_BASE_URL`: Bark 服务地址，默认 `https://api.day.app`。
- `CTRIP_STORAGE_STATE`: Playwright storage state。可以填 JSON 文件路径，也可以直接填完整 JSON 字符串。如果携程拦截无登录/无 Cookie 访问，可在本机浏览器完成访问后导出登录态，再让脚本加载。
- `CTRIP_API_WAIT_MS`: 等待携程 `batchSearch` 响应的毫秒数，默认 `45000`。

## 运行

```bash
npm install
npm run monitor
```

## 导出携程浏览器状态

如果后台运行被携程拦截，先在本机运行：

```bash
npm run auth
```

它会打开一个有界面的浏览器。你在浏览器里手动完成访问、验证或登录，确认航班列表可以正常显示后，回到终端按回车。脚本会保存：

```bash
data/ctrip-storage-state.json
```

随后本机可这样测试：

```bash
CTRIP_STORAGE_STATE=data/ctrip-storage-state.json npm run monitor
```

Arcadia 中填入环境变量：

```bash
CTRIP_STORAGE_STATE=data/ctrip-storage-state.json
```

如果 Arcadia 不能读取本机文件，也可以把 `data/ctrip-storage-state.json` 的完整内容作为 `CTRIP_STORAGE_STATE` 环境变量值粘贴进去。注意不要把这个 JSON 提交到 GitHub 或公开日志里。

如果 Arcadia 使用定时任务运行，命令保持为：

```bash
arcadia run repo/admin05_ctrip-flight-monitor/src/monitor.js
```

脚本支持 Arcadia 直接运行 JS 文件：如果缺少 `playwright`，会自动在仓库根目录执行 `npm install`；如果缺少 Playwright Chromium 运行时，会自动执行 `npx playwright install chromium`。

脚本每次运行都会输出结果；如果 `BARK` 存在，会推送脚本名称、运行状态、航班信息、最低价格和价格变化摘要。

脚本优先监听携程页面发出的 `batchSearch` 接口响应并解析 `flightItineraryList`，匹配目标航班号后读取经济舱成人最低价；如果没有拦截到接口结果，再回退到页面文本解析。

## 注意

携程航班页面可能返回 `whaleguard block`，这表示网站反爬系统拦截了自动化访问。脚本会识别该情况并通过 Bark 推送失败原因；如需长期稳定运行，建议在 Arcadia 环境中提供可用的浏览器登录态，或改用可授权的航班数据接口。
