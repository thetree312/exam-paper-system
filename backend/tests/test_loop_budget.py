from app.agent.assistant_graph.loop_budget import new_turn_loop_budget


def test_new_turn_loop_budget_resets_steps() -> None:
    budget = new_turn_loop_budget()
    assert budget["max_steps"] == 8
    assert budget["steps_taken"] == 0
    assert budget["tool_calls"] == 0
    assert budget["repeated_calls"] == 0
    assert "turn_id" in budget


def test_new_turn_loop_budget_normalizes_invalid_values() -> None:
    assert new_turn_loop_budget(0) == {
        "max_steps": 8,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
        "turn_id": None,
    }
    assert new_turn_loop_budget(-3) == {
        "max_steps": 8,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
        "turn_id": None,
    }
    assert new_turn_loop_budget("x") == {  # type: ignore[arg-type]
        "max_steps": 8,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
        "turn_id": None,
    }
    assert new_turn_loop_budget(6) == {
        "max_steps": 6,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
        "turn_id": None,
    }
    assert new_turn_loop_budget(6, turn_id="run-1") == {
        "max_steps": 6,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
        "turn_id": "run-1",
    }

