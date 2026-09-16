# 版本规范

- 发布版本使用简洁的 `MAJOR.MINOR.PATCH`，例如 `1.2.0`、`1.2.1`。
- 修复递增 PATCH，兼容的新功能递增 MINOR，不兼容变更递增 MAJOR。
- 不使用 `+codex.*`、时间戳或缓存后缀作为发布版本；更新安装版时也遵循此规则。
- 发布时同步更新 `.codex-plugin/plugin.json` 与 `CHANGELOG.md`，重新安装后核对版本。
