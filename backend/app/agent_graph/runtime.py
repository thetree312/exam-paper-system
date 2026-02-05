from __future__ import annotations



import logging

from pathlib import Path



from ..skills.manager import SkillManager



logger = logging.getLogger("agent.graph")

SKILL_MANAGER = SkillManager(base_dir=(Path(__file__).resolve().parent.parent / "skills"))



__all__ = ["logger", "SKILL_MANAGER"]

