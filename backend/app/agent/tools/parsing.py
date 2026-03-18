from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("agent.tools")


def parse_tool_arguments(raw_arguments: Any) -> dict[str, Any]:
    if isinstance(raw_arguments, dict):
        logger.info("agent.parse_tool_arguments type=dict keys=%s", list(raw_arguments.keys())[:10])
        return raw_arguments
    if isinstance(raw_arguments, str):
        text = raw_arguments.strip()
        if not text:
            logger.info("agent.parse_tool_arguments type=str empty=true")
            return {}
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                logger.info("agent.parse_tool_arguments type=str parsed=dict keys=%s", list(obj.keys())[:10])
                return obj
            logger.warning("agent.parse_tool_arguments type=str parsed_non_dict value_type=%s", type(obj).__name__)
            return {"_raw": obj}
        except json.JSONDecodeError:
            logger.warning("agent.parse_tool_arguments type=str invalid_json preview=%s", text[:300])
            return {"_raw_text": raw_arguments}
    logger.info("agent.parse_tool_arguments unsupported_type=%s", type(raw_arguments).__name__)
    return {}
