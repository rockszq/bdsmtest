# 回归测试机制

## 为什么需要

本次优化过程中出现过 4 个「修复引入新 bug」的案例（反向题双重翻转、canvas 不支持 CSS 变量、
updateProgress 守卫失效、低倾向画像被误判为冲突）。教训：**每次修改必须重跑全部验证，
且验证必须跑页面真实代码而非人工复刻的逻辑**（复刻逻辑和页面代码会悄悄不同步）。

2026-11-17 追加教训：**门禁本身也会有缺陷**。故障注入证明当时 10 类历史 bug 有 4 类能穿透
四层门禁（链接正则假匹配、低倾向冲突缺断言、伪科学措辞只 warn、承诺检查白名单漏新词）。
因此新增第五层 `verify_gate.py`（meta-test），用故障注入验证门禁有效性。

## 四层防线

| 层 | 脚本 | 覆盖内容 |
|---|---|---|
| 结构层 | `verify_scale.py` | 48 题结构、维度分布、反向题分值升序、S/D 构念纠缠措辞扫描、阈值硬编码扫描 |
| 计分层 | `verify_runtime.mjs` | Node vm 执行页面 JS：6 种人格定向作答的计分、反向题翻转、理论满分 |
| 端到端 | `test_e2e.mjs` | 真实页面代码 + 最小 DOM mock，13 种人格画像跑完整 `showResults()`，校验**分数与结果文案自洽**（核心发现、维度描述、特征组合提示、作答质量因子） |
| UI 静态 | `verify_ui.py` | 链接色、文案承诺有实现、canvas 字面色、CSS 类/变量/id 引用完整性、JS 语法 |

## 第五层：门禁体检（meta-test）

`verify_gate.py` 不检查页面，而是**检查检查器**：把 10 类历史真实 bug 逐一植入临时副本，
确认四层门禁至少有一层报 FAIL。当前 10/10 全拦截。

**何时必跑**：改动任何 `verify_*.py` / `test_e2e.mjs` / `run_all.py` 之后。
检查器改坏了而页面没变时，四层全绿会给出虚假的安全感——只有 meta-test 能发现。

## 用法

```bash
# 全量回归（修改 index.html 后必须跑）
python tests/run_all.py

# 门禁体检（修改任何检查器后必须跑，约 20 秒）
python tests/verify_gate.py

# 单独跑某一层
python tests/verify_scale.py
node tests/verify_runtime.mjs
node tests/test_e2e.mjs
python tests/verify_ui.py
```

退出码 0 = 全部通过。任何一层失败都不允许交付。

## 版本回滚（git 不可用时的兜底）

本仓库 git 零 commit、所有文件 untracked，**不能靠 git 回滚**。
`deploy_bdsmtest.py` 每次部署前会把当前 `index.html` 存入 `snapshots/index.YYYYMMDD-HHMMSS.html`，
保留最近 10 个。回滚时把目标快照复制回 `index.html` 再部署即可。
远端另有一份 `index.html.bak-20261016`（改造前旧版），但已过期，仅作最后兜底。

## 扩展新用例的场景

- **改题库/加反向题**：结构层会自动校验新题；端到端的 `buildAnswers()` 按维度构念强度构造作答，反向题自动翻转
- **改评分/质量检测逻辑**：端到端模拟 9–12 覆盖了「语义一致画像」「直线作答」「讨好作答」「极速作答」四类边界
- **改结果文案**：端到端的 `expectDescMatch` 校验分数段与描述词的映射

## 关键约定（防再次踩坑）

1. 反向题的数据层分值必须保持**自然升序 0..4**，由 `reverse: true` 标记在评分层统一翻转——两层都改就会双重翻转
2. canvas 的 `fillStyle/strokeStyle` **不支持 CSS var()**，只能写字面色值（改 `:root` 色值时同步 `renderRadarChart` 内的 4 处字面色）
3. JS 里删除 HTML 元素后，必须检查所有引用它的守卫条件（如 `updateProgress`）
4. 反向题一致性检测区分**四种情形**：高倾向一致 / 低倾向一致 / 方向冲突 / 无法评估——低倾向一致（正向低+反向高）是自洽作答，绝不能报冲突

## 2026-10-16 补充：借鉴优化（对标 BDSMTest.org + KOS）

新增功能及对应回归断言：
- 18+ 年龄确认门（`ageGate` checkbox，未勾选时 startFlow 不放行）→ 端到端模拟 13
- 结果页类型概括（`getTypeProfile`：主导型/臣服型/双向切换型/温和传统型/均衡探索型）→ 模拟 1/2/6/8 各断言类型词
- 维度定义展示（fullDesc）、协商与沟通自评清单（KOS sexual communication 因子借鉴）
- 「关于本问卷」设计说明与局限（诚实定位）

改动这些函数时须同步：`startFlow` / `getTypeProfile` 已加入 e2e 测试钩子导出列表，
新增内部函数要在 hook 里显式导出（否则 e2e 报 not a function——本轮已踩过一次）。
