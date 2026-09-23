# Animation 工具（Creator 3.8）

构建：`npm run build`。随后在 Creator 扩展管理器重新加载 `cocos-mcp-server`。
已有工具配置会补入新发现的工具，保留已有开关设置。客户端重新读取 tools/list 后应看到：

- `animation_create_clip`：创建独立 `.anim`，已有路径拒绝覆盖。
- `animation_get_clip`：读取轨道索引、路径、通道关键帧、事件及 revision。
- `animation_edit_tracks`：批量追加、替换、删除轨道；必须提供最新 revision。
- `animation_attach_clip`：挂载到已有 `cc.Animation`，支持撤销；调用方随后保存场景或预制。

## 创建例子

```json
{
  "url": "db://assets/bundle_game/anim/scoreboard_state.anim",
  "name": "scoreboard_state",
  "duration": 0.016666666666666666,
  "sample": 60,
  "tracks": [
    { "kind": "active", "path": "bg", "keys": [{ "time": 0, "value": true }] },
    { "kind": "spriteFrame", "path": "bg", "keys": [{ "time": 0, "value": { "uuid": "替换为完整 SpriteFrame 子资源 UUID" } }] }
  ]
}
```

path 相对于挂载 Animation 的节点，空字符串表示自身。spriteFrame 必须是子资源 UUID，不能使用 Texture2D 的 UUID；null 表示清空图片。

支持轨道：spriteFrame、active、position、scale、number。位置/缩放值为完整的 `{x,y,z}`，number 需要 component（如 `cc.UIOpacity`）及 property（如 `opacity`）。数值轨道线性插值，对象轨道阶跃切换。关键帧时间单位为秒，必须递增、无重复，且不超过动画时长。

编辑时 tracks 中的 index 指定原轨道索引，省略表示追加；remove 为删除索引数组。所有索引按修改前文档解释，不能同时替换和删除同一轨道。此次 API 不调整现有 clip 时长、事件、循环模式或未知轨道。

## 实现与验证

场景进程用实际引擎 Track API 构建轨道，并由 EditorExtends.serialize 生成格式。主进程无损合并序列化对象图，保留未修改的轨道、事件和资源引用，移除不可达对象；资产数据库负责写入和导入，更新保留 UUID。

写入前检查 revision，写入后核对文件和 UUID，再通过引擎重新加载核对轨道数和时长。写入后验证失败会返回 `success:false` 和 `data.assetWritten:true`；不会假报成功或自动覆盖恢复。revision 不能消除编辑器在最后检查与实际写入之间的极短并发窗口。

导入验证先检查资源数据库就绪状态。对暂态 CCON 格式错误、导入未就绪或加载到旧轨道数量的情况，最多进行 6 次只读验证（间隔 100/200/400/800/1000 毫秒），不重复写入。每次检查源文件版本；其他错误立即返回。成功结果包含 verificationAttempts。

本地回归：`node --test tests/animation.test.cjs`（先 build）。包含项目现有动画的保留验证和模拟编辑器接口测试；这不替代真实编辑器验收。

真实回归应在独立测试资源和节点上执行：创建带 SpriteFrame/active/position 的 clip → 读取 → 替换、追加、删除 → 挂载 → 播放采样 → 保存并重新打开。核对切图、显隐、位置、引用、默认动画、原轨道和事件均符合预期。不要直接用正在编辑的业务 prefab 做破坏性测试。

2026-09-09 验证：12 项本地测试通过；重载后的真实 MCP 完成 20 次连续替换及 5 轮删除/追加（共 30 次编辑），全部成功。重新加载测试预制后，5 类轨道在 4 个时点的引擎采样符合预期。该轮实测未触发重试；暂态重试、重试上限及永久错误立即失败由自动化测试覆盖。临时测试资源已清理，浏览器视觉预览未验收。
