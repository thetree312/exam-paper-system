from __future__ import annotations


def test_dialogue_focus_keeps_subject_scope_for_follow_up_and_correction() -> None:
    from app.agent.assistant_graph.dialogue_focus import derive_dialogue_focus

    messages = [
        {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
        {"role": "assistant", "content": "我判断它是(3,1)。"},
        {"role": "user", "content": "那这道题的解题步骤是什么"},
    ]
    focus = derive_dialogue_focus(messages=messages, previous_scope=None)

    assert focus["subject_scope"] == "第六题图例里视风风速的坐标是什么"
    assert focus["turn_intent"] == "那这道题的解题步骤是什么"
    assert focus["feedback_signal"] is None

    correction_messages = [
        *messages,
        {"role": "assistant", "content": "步骤如下。"},
        {"role": "user", "content": "不对，你把箭头看反了"},
    ]
    focus = derive_dialogue_focus(messages=correction_messages, previous_scope=focus["subject_scope"])

    assert focus["subject_scope"] == "第六题图例里视风风速的坐标是什么"
    assert focus["turn_intent"] == "不对，你把箭头看反了"
    assert focus["feedback_signal"] == "不对，你把箭头看反了"


def test_dialogue_focus_can_reset_subject_scope_on_explicit_switch() -> None:
    from app.agent.assistant_graph.dialogue_focus import derive_dialogue_focus

    messages = [
        {"role": "user", "content": "帮我定位订单为什么没发货"},
        {"role": "assistant", "content": "我先检查履约状态。"},
        {"role": "user", "content": "换个问题，第八题第二问怎么做"},
    ]

    focus = derive_dialogue_focus(messages=messages, previous_scope="帮我定位订单为什么没发货")

    assert focus["subject_scope"] == "换个问题，第八题第二问怎么做"
    assert focus["turn_intent"] == "换个问题，第八题第二问怎么做"
    assert focus["feedback_signal"] is None
