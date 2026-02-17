from __future__ import annotations

import logging
from pathlib import Path

from ..skills.manager import SkillManager

logger = logging.getLogger("assistant.graph")

# 复用现有 skills 目录，但与旧 agent_graph 解耦
SKILL_MANAGER = SkillManager(base_dir=(Path(__file__).resolve().parent.parent / "skills"))

__all__ = ["logger", "SKILL_MANAGER"]
