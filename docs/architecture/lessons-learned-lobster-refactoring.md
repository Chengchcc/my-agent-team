# Lobster Refactoring — Lessons Learned

## What went wrong

### 1. 没有先定架构再写代码
- PRD/spec 写了，但没有在动手前把目录结构和 import 依赖图设计精确
- 边写边调目录，导致反复 mv/sed，import 路径多次损坏
- 应该先画 DAG，再逐文件迁移

### 2. 目录重构和功能实现混在一起
- 同时在做"实现 stub"和"移动目录"，产生大量冲突
- 应该分离：先定目录 → 一次性移动（只改路径不改逻辑） → 验证编译 → 再实现功能

### 3. 缺少防腐层设计
- 没有明确的层边界，bootstrap/extensions/services 之间耦合混乱
- 应该从 DDD 出发，core（框架层）不依赖 domains（业务层），domains 之间只通过 EventBus 通信

### 4. CLI/TUI 没有被视为 frontend
- TUI 直接依赖内部实现细节（McpManager, SkillLoader 等）
- 应该把 TUI/Lark 都视为 frontend，只通过 core 公共 API 访问

### 5. 没有自动化工具辅助
- madge 可以生成 import DAG，应该在开始前就跑一遍
- 批量 sed 不可靠，应该用更精确的工具

## What to do differently

1. **先设计目录 DAG**：确定每个包的依赖方向，得到用户确认再动手
2. **分离步骤**：目录移动 → 验证编译 → 功能实现 → 补充测试
3. **DDD 分层**：core/（框架）← domains/（业务）← frontends/（界面）
4. **防腐层**：每个 domain 通过 core/agent/extension 接口接入，不直接 import 其他 domain
5. **用 madge 验证**：移动前后各跑一次，确保依赖方向正确
