# 冗余离散链路惯性延迟复核

航电维修复核工具：对最多 12 个 NOT / AND / OR 门组成的冗余离散链路做事件驱动仿真，
按正整数**惯性延迟**与**待发事件撤销**语义逐刻推进，在开关抖动后识别：

- **短脉冲（glitch）**：受监控输出上过窄的电平段，给出起止刻度、宽度与可回溯到外部边沿的因果事件链；
- **失效翻转不落轨迹**：输入扰动短于门延迟时，已安排的翻转在生效前被撤销，最终电平与逐刻轨迹均不被污染；
- **持续振荡**：外部边沿结束后，以“门当前值 + 相对待发事件”规范化状态，签名重复即给出振荡前缀与可回放循环（稳定门顺序、事件标识、周期、振荡门）；
- **静稳**：边沿结束且无待发事件后输出不再变化。

校验类错误（悬空连线、同一门重复接入同一驱动、非法/矛盾边沿、环内零延迟、门标识缺失或重复、非正整数延迟、非法监控输出等）逐项列出，并在页面与 API 上取代旧结论。

## 目录

```
src/sim.js       仿真内核（校验 / 事件驱动推进 / 撤销 / 短脉冲 / 振荡 / 规范化哈希）
src/server.js    零依赖 HTTP 服务：/health、/api/review、静态托管构建产物
web/             录入页面（原生 ESM，浏览器直接复用同一仿真内核）
scripts/build.mjs  esbuild 打包页面到 web/dist
scripts/verify.mjs 一次性验收（断言 → 测试 → 构建 → HTTP 冒烟），以退出码报告
test/sim.test.js  node --test 单元测试
compose.yml      可配置宿主端口的服务 + verify 一次性验收服务
```

## 本地运行

```bash
npm install --cache ./.npm-cache
npm run build          # 产物输出到 web/dist
npm start              # 默认 0.0.0.0:8080，可用 HOST/PORT 环境变量覆盖
# 健康检查
curl -s http://127.0.0.1:8080/health
```

环境变量：`HOST`（默认 `0.0.0.0`）、`PORT`（默认 `8080`）。

## 一次性验收

```bash
npm run verify         # 或：node scripts/verify.mjs；HOST/PORT 可配置
```

`verify` 执行完毕后退出，退出码 0/1 即验收结果。顺序：

1. 三个规定场景断言：宽度 2 短脉冲及因果链；延迟 3 的 NOT 在第 0/1 刻反转时撤销第 3 刻失效翻转；正延迟反馈链振荡证据；
2. `node --test` 代码测试；
3. 页面构建；
4. 在可配置宿主端口启动服务并做 `/health`、`/api/review` 与首页 HTTP 冒烟。

## Compose

```bash
PORT=9090 docker compose up --build -d      # 宿主 0.0.0.0:9090
docker compose --profile verify run --rm verify   # 一次性验收，退出码即结果
```

## 配置 JSON（页面等价录入）

```json
{
  "gates": [
    { "id": "N", "type": "NOT", "delay": 3, "inputs": ["input:x"] }
  ],
  "edges": [
    { "time": 0, "input": "x", "from": 0, "to": 1 },
    { "time": 1, "input": "x", "from": 1, "to": 0 }
  ],
  "initialInputs": { "x": "0" },
  "monitors": ["N"]
}
```

- 门连线写门标识（取门输出）或 `input:名称`（外部输入）。
- 外部输入初始电平取该输入最早一条边沿的 `from`，或由 `initialInputs` 显式给出。
- `monitors` 留空时默认监控全部门输出。

## 仿真语义要点

- 同刻事件按稳定顺序处理：外部边沿（按输入名）与到期待发事件（按门标识）并发生效后，对受影响门闭包按门标识迭代重算，直到本刻无新结论。
- 门输出仅在其计算值相对当前值连续保持满 `delay` 个刻度时翻转；中途恢复则撤销待发事件，撤销/安排均进入事件流水。
- 所有环路上的门延迟必须为正整数，否则报 `ZERO_DELAY_CYCLE`。
- 边沿结束后每刻生成规范化状态签名（门值与相对当前刻度的待发事件）；签名重复判定循环，无待发事件判定静稳；观察窗口耗尽仍无结论为 `UNRESOLVED`。
