# Agent Runtime 工作交接

日期：2026-03-16  
范围：[runtime_bootstrap.py](/d:/Exam-paper/backend/app/agent/assistant_graph/runtime_bootstrap.py)、[world_model.py](/d:/Exam-paper/backend/app/agent/assistant_graph/world_model.py)、工具回包协议、连续思考承载方式

## 1. 当前面对的问题

当前问题不是某个工具选错了，也不是某句 prompt 没写好，而是 **agent runtime 的主循环和状态承载方式有根缺陷**。  
这次测试场景把问题暴露得很彻底：

- 用户请求：“第六题图例视风风速的坐标是什么”
- 工作区为空
- 知识库里有两个文件

理想行为应该更像人：

- 先判断自己是否已经知道“第六题”具体指向哪个对象
- 如果对象还没有唯一落定，先消除这个关键不确定性
- 只有在理解足够稳定时，才继续找证据

当前 agent 的实际行为不是这样，而是：

- 先看工作区
- 再搜知识库
- 再读文本证据
- 最后因为证据是图片或文本缺失而卡住

这说明当前 agent 更像一个“工具调用执行器”，不像一个“先理解再行动”的主体。

## 2. 当前陷入的困境

### 2.1 伪循环

现在的 LangGraph 结构表面上是循环：

- `memory_sync -> decide -> execute_tools -> memory_sync`

但认知上不是连续循环，而是“多次独立新调用串起来的伪循环”。

表现为：

- 每轮都重新组装一份 prompt
- 每轮都重新描述用户问题和环境
- 每轮都像重新开题
- 上一轮结果没有变成下一轮的正式状态，只是消息历史的一部分

这也是为什么 [agent思考.txt](/d:/Exam-paper/agent思考.txt) 里会反复出现类似开头：

- 用户询问……
- 当前环境……
- 我需要先……

这不是连续修正，而是分段重启。

### 2.2 世界表达不闭合

当前世界表达长期存在两个问题：

- 用模糊计数字段表达世界，例如 `kb_source_count=2`
- 把世界事实和工程结论混在一起

典型问题字段包括：

- `kb_source_count`
- `target_resolution`
- `answerability`
- `evidence_status`
- 曾经存在过的 `focus`

这些字段的问题是：

- 模型拿到的不是“世界里有什么”
- 而是“工程侧已经解释过一遍后的世界”

结果就是 agent 容易顺着工程预设走，而不是自己理解。

### 2.3 主推理单位错了

当前系统长期把 agent 的正式主输出做成：

- `response`
- `tool_calls`

也就是“下一步做什么”。

只要主输出原子还是动作，agent 就会天然滑向：

- 看当前环境
- 选一个工具
- 拿结果
- 再选一个工具

这会稳定地把 agent 退化成动作选择器。

## 3. 高置信度问题判断

### 3.1 根因一：上一轮结果没有成为下一轮正式状态

现在上一轮结果主要躺在这些地方：

- `assistant/tool` 历史消息
- `thinking_accumulator`
- `world_model` 里的工程摘要

而不是一个正式、稳定、唯一的“上一轮我已经确认了什么”的状态对象。

所以下一轮不是：

- 我已经知道 A
- 这轮新知道了 B
- 所以修正成 C

而是：

- 我再读一遍历史
- 我再拼一次意义
- 我再决定下一步

这就是伪循环的根因。

### 3.2 根因二：world model 仍然越权

[world_model.py](/d:/Exam-paper/backend/app/agent/assistant_graph/world_model.py) 现在虽然已经比前面干净，但活跃路径里仍然承担了过多解释职责。

它不应该替 agent 做这些事：

- 解释当前目标是否已解析
- 解释当前证据是否足够
- 解释该把注意力放在哪里

它应该只做：

- 环境事实缓存
- 对象清单
- 最近观察记录

现在这个边界没有完全切干净。

### 3.3 根因三：连续性仍然主要靠消息历史，不靠正式状态

当前所谓 continuity，依然主要靠：

- persisted messages
- tool history
- thinking tail

来维持。

这会导致：

- 工具轨迹前景化
- 世界关系背景化
- 新观察没有被正式吸收到稳定状态里

结果就是模型每轮仍然更容易沿工具链滑，而不是先判断自己当前到底理解到了哪里。

## 4. 已尝试过的方法与效果

### 4.1 共享黑板 / cognition blackboard

做法：

- 增加 `cognition_blackboard.py`
- 用黑板承载 beliefs / uncertainties / tensions 等状态

效果：

- 很快滑成手写 schema + 手写规则
- 工程侧开始替 agent 做语义理解
- 去掉特例后行为迅速退化

结论：

- 这次实现失败，已整体放弃
- 失败原因不是“黑板概念一定错”，而是实现被写成了规则解释器

### 4.2 场景化启发式 / 共享指称优先

做法：

- 强化 prompt，让 agent 先处理“对象是否已绑定”
- 一度围绕“第六题 + 多文档”场景加过启发式

效果：

- 局部会改善
- 但明显属于场景驱动
- 用户明确反对这种优化方向

结论：

- 已放弃

### 4.3 两段式“先解释后行动”

做法：

- 在 `decide` 前再加一次模型调用
- 先生成解释包，再基于解释包选动作

效果：

- 没让 agent 更像人
- 反而把一轮思考拆成了两轮工程控制
- 行为改善不明显，甚至更像流程机

结论：

- 已回滚

### 4.4 只改 prompt / continuity / 去 focus

做法：

- 去掉工程侧 `focus`
- 改 continuity prompt
- 改 system prompt 口径

效果：

- 这些改动是必要的清理
- 但不改变主因果
- live 行为几乎没有根本变化

结论：

- 这些可以保留
- 但不能算解决方案

### 4.5 单次结构化决策：`state_revision + action`

做法：

- 不再走“自由文本 + tool_calls”
- 改成单次 `decide` 输出：
  - `state_revision`
  - `action`
- 希望让上一轮结果进入正式状态，而不是只躺在历史消息里

效果：

- 测试层面可以跑通
- 但 live case 失败
- 当前 `qwen3.5-plus` 在 `chat_stream` 下不能稳定只吐可解析 JSON

结论：

- 方向上比前几种更接近真正解法
- 但当前输出约束方式不够硬，不能直接用于生产

## 5. 当前正在进行的解决方法

### 5.1 活跃方案

当前活跃方案不是黑板，不是两段式解释，也不是场景规则。  
当前主线是：

- 让上一轮结果变成正式状态，而不是历史消息
- 让下一轮主要继承正式状态，而不是继承 `thinking_accumulator`
- 把决策的正式产物从“动作”升级为“状态修订 + 动作”

也就是：

- `state_revision`
- `action`

这是目前唯一还保留的主方向。

### 5.2 当前代码状态

当前代码里已经落地的部分：

- [runtime_bootstrap.py](/d:/Exam-paper/backend/app/agent/assistant_graph/runtime_bootstrap.py) 的 `GraphState` 已包含 `state_revision`
- `memory_sync` 已开始优先继承 `state_revision.summary`
- `decide` 已尝试走结构化决策输出
- `thinking_accumulator` 不再被当作正式认知状态

### 5.3 当前卡点

当前最大卡点不是 LangGraph，也不是工具，而是：

**结构化输出方式不稳定**

现状是：

- 现在依赖 prompt 要求模型只输出 JSON
- 测试里可控
- live case 里不稳定

已经出现的实际现象：

- `agent.decide` 调用成功发出
- `chat_stream` 返回空文本或非 JSON 文本
- `_parse_decision_payload()` 直接报 `decision_parse_error: invalid_json`
- 整轮以空回复结束

所以问题不在“要不要结构化输出”，而在：

- 当前结构化输出通道太脆

## 6. 当前最合理的下一步

下一步不应该再去：

- 改场景 prompt
- 加 fallback
- 再引入黑板
- 再拆一层解释节点
- 再做“第六题/多文档”特殊优化

当前最合理的下一步应该是：

1. 保持 `state_revision + action` 这个主因果不动
2. 把“prompt 约束 JSON”升级成更硬的结构化输出通道
3. 优先检查 `QwenClient` / DashScope 兼容层是否支持：
   - `response_format`
   - `json_schema`
   - 其他 API 级结构化输出能力
4. 如果 API 级结构化输出不可用，则改为让模型通过“结构化 tool call”提交决策对象

原则是：

- 不回退到多次模型调用
- 不回退到工程侧认知解释
- 不增加 fallback 兜底
- 不做特殊场景优化

## 7. 给接手者的注意事项

### 必须保持的边界

- 工程侧不做语义理解
- 工程侧不替 agent 决策
- world model 只做事实层
- 工具只返回原始观察，不返回结论型认知字段

### 当前不要再做的事

- 不要再引入 cognition blackboard 规则系统
- 不要再拆成“先解释后行动”的两次调用
- 不要再围绕测试场景做启发式规则
- 不要只改 prompt 就声称认知问题已解决

### 当前最重要的风险

如果下一步仍然停留在：

- prompt 调优
- continuity 文案改写
- world snapshot 字段换名

而不处理“正式状态承载 + 结构化输出稳定性”，那么很大概率会继续出现：

- 测试能过
- live 行为无改善或直接崩

## 8. 一句话总结

当前我们真正面对的，不是一个“怎么让 agent 先问一句”的问题，而是：

**怎么把一个依赖消息历史和工具轨迹的伪循环执行器，改造成一个以上一轮正式状态为基础连续推进的 agent。**

目前已经找到相对正确的主方向：

- `state_revision + action`

但还没有把输出通道做到 live 可用。当前接手工作的重点，应集中在这个点上，而不是继续外围调参。
