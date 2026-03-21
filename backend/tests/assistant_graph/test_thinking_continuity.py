from __future__ import annotations

from app.agent.assistant_graph.adapters.message_adapter import build_continuity_prompt as _build_continuity_prompt


def test_continuity_prompt_carries_recent_world_observations_not_tool_summary() -> None:
    prompt = _build_continuity_prompt(
        step_count=2,
        previous_thinking="上一轮我确认了工作区为空，知识库中有两个文件。",
        latest_user_query="第六题图例里视风风速的坐标",
        latest_tool_observation='{"recent_observations":[{"kind":"knowledge_base_hit","refs":["chunk:348"]}]}',
    )

    assert "本轮新增观察:" in prompt
    assert "knowledge_base_hit" in prompt
    assert "最近工具观察" not in prompt
    assert "下一动作" not in prompt
    assert "持续解释链" not in prompt
    assert "连续思考" in prompt


def test_continuity_prompt_carries_previous_interpretation_tail() -> None:
    prompt = _build_continuity_prompt(
        step_count=3,
        previous_thinking="上一轮我确认工作区为空，但还没有确认用户说的对象具体落在哪个文件里。",
        latest_user_query="第六题图例里视风风速的坐标",
        latest_tool_observation="{}",
    )

    assert "上一轮判断结尾:" in prompt
    assert "工作区为空" in prompt
