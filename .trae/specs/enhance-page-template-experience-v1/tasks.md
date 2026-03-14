# Tasks

- [x] Task 1: 定义 PageTemplate 高级 UI Schema（registry/variants/prefs）
  - [x] SubTask 1.1: 扩展 API `pageModel`：新增 layout/blocks（向后兼容）
  - [x] SubTask 1.2: 定义 registry allowlist 结构与校验规则（server 侧）
  - [x] SubTask 1.3: Web types 同步（UiPageVersion 与相关类型）

- [x] Task 2: 实现个人视图偏好存储与接口
  - [x] SubTask 2.1: 新增 view prefs 存储（推荐新表：tenant/space/subject/pageName）
  - [x] SubTask 2.2: 提供 API：get/upsert/reset（并做权限与 scope 校验）
  - [x] SubTask 2.3: 合并策略：released.ui + prefs → effective view（非法字段忽略）

- [x] Task 3: Web 端渲染器引入 Component Registry 与 Layout Variants
  - [x] SubTask 3.1: 实现 registry（componentId→component）与 props 解析/默认值
  - [x] SubTask 3.2: list/detail/form 增加 layout.variant 分支（至少 2 个变体）
  - [x] SubTask 3.3: 实现多端降级规则（小屏强制 single-column/简化列）

- [x] Task 4: 偏好交互与体验（保存/重置/即时预览）
  - [x] SubTask 4.1: list 偏好：列显示/顺序、密度、默认排序保存
  - [x] SubTask 4.2: detail/form 偏好：布局变体与字段分组偏好（可选最小集）
  - [x] SubTask 4.3: 提供“恢复默认”与“仅本设备/全局”策略（至少先做全局）

- [x] Task 5: 控制台 IA 与品牌收尾
  - [x] SubTask 5.1: 修正 `layout.tsx` metadata title/description 与 html lang
  - [x] SubTask 5.2: 导航分组与命名统一（运行/治理/管理/设置）
  - [x] SubTask 5.3: 多端导航策略（小屏隐藏侧边栏→抽屉/菜单）

- [x] Task 6: 验证（e2e/类型/回归）
  - [x] SubTask 6.1: API：registry 校验拒绝非法 componentId；prefs 保存/读取/重置
  - [x] SubTask 6.2: Web：variant 切换、移动端降级、prefs 合并生效
  - [x] SubTask 6.3: 文档：补充“registry/variants/prefs/多端策略/品牌配置项”

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 1, Task 2, Task 3, Task 4, Task 5
