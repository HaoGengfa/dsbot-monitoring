# Changelog

## 0.1.0 — 2026-11-09

首个版本。

- 左侧导航新增「作战室」入口（`sidebar` slot，order 30）
- 看板四块：拓扑带 / 日志流 / 成员思考卡 / 统计条
- 实时快照接口 `GET /bot-stage/api/live`，1 秒轮询
- 复盘回放接口 `GET /bot-stage/api/replay?from=&to=` 与 `replay.html` 页面
- 任务确认接口 `POST /bot-stage/api/tasks/confirm`
- 会话日志按需增量解析：只读尾部约 320 KB、最多解压 56 帧，未变化则复用缓存
- 全部数据只读本地文件，不外发、不改写被读文件
