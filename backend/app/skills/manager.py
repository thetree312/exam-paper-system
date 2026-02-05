from __future__ import annotations



import json

import logging

from dataclasses import dataclass, field

from pathlib import Path

from typing import Any, Dict, List





logger = logging.getLogger("agent.skills")





@dataclass

class SkillConfig:

    name: str

    kind: str

    description: str

    template: str

    summary: str | None = None

    when: List[str] = field(default_factory=list)

    schema_example: Any = None

    extra_notes: str | None = None

    output_schema: Any = None

    agent: str = "solver"

    doc_sections: Dict[str, str] = field(default_factory=dict)

    default_full_sections: List[str] = field(default_factory=list)





class SkillManager:

    """Load and render skill templates grouped by agent category."""



    def __init__(self, *, base_dir: Path) -> None:

        self.base_dir = base_dir

        self._meta_root = self.base_dir / "meta"

        self._docs_root = self.base_dir / "docs"

        self._skills: dict[str, dict[str, SkillConfig]] = {}

        self._doc_cache: dict[Path, str] = {}

        self._load_all()



    def _load_all(self) -> None:

        meta_root = self._meta_root if self._meta_root.exists() else self.base_dir

        if not meta_root.exists():

            logger.warning("skill.meta_root_not_found path=%s", meta_root)

            return

        for agent_dir in meta_root.iterdir():

            if not agent_dir.is_dir():

                continue

            agent = agent_dir.name

            for skill_file in agent_dir.glob("*.json"):

                try:

                    raw = skill_file.read_text(encoding="utf-8")

                    data = json.loads(raw)

                except Exception as exc:

                    logger.warning("skill.load_failed file=%s error=%s", skill_file, exc)

                    continue

                config = SkillConfig(

                    name=data.get("name") or skill_file.stem,

                    kind=data.get("kind") or "instruction",

                    description=data.get("description") or "",

                    template=data.get("template") or "",

                    summary=data.get("summary"),

                    when=list(data.get("when") or []),

                    schema_example=data.get("schema_example"),

                    extra_notes=data.get("extra_notes"),

                    output_schema=data.get("output_schema"),

                    agent=agent,

                    doc_sections=dict(data.get("doc_sections") or {}),

                    default_full_sections=list(data.get("default_full_sections") or []),

                )

                self._skills.setdefault(agent, {})[config.name] = config

                logger.info(

                    "skill.loaded agent=%s name=%s when=%s", agent, config.name, config.when

                )



    def list_skills(self, agent: str) -> List[str]:

        return sorted(self._skills.get(agent, {}).keys())



    def get_skill(self, agent: str, name: str) -> SkillConfig | None:

        return self._skills.get(agent, {}).get(name)



    def render_instructions(

        self, *, agent: str, tags: List[str], context: Dict[str, Any], mode: str = "full"

    ) -> tuple[List[str], List[dict]]:

        """Return activated skill names and rendered system messages.



        mode:

            - "summary": 仅返回每个技能的短摘要（优先使用 summary 字段，其次 description，

              最后回退到截断后的 template），用于 progressive disclosure 的轻量提示；

            - "full": 使用完整 template 渲染（当前默认行为），适用于确认为需要该技能

              详细规则的场景。

        """

        activated: List[str] = []

        messages: List[dict] = []

        tag_set = set(tags or [])

        for cfg in self._skills.get(agent, {}).values():

            when = set(cfg.when or [])

            if tag_set and when and not (tag_set & when):

                continue

            if cfg.kind != "instruction":

                continue

            if mode == "summary":

                # 渐进式披露：优先使用显式 summary；否则使用 description；

                # 若仍为空则回退到截断后的 template，避免把整段长模板注入。

                text = (cfg.summary or cfg.description or "").strip()

                if not text:

                    tmpl = (cfg.template or "").strip()

                    max_len = 200

                    if len(tmpl) > max_len:

                        tmpl = tmpl[: max_len - 3] + "..."

                    text = tmpl

                rendered = text

            else:

                sections = cfg.default_full_sections or list(cfg.doc_sections.keys())

                rendered = self._render(cfg, context, sections=sections)

            if not rendered:

                continue

            activated.append(cfg.name)

            messages.append({"role": "system", "content": rendered})

        return activated, messages



    def render_instruction_by_name(

        self,

        *,

        agent: str,

        name: str,

        context: Dict[str, Any],

        mode: str = "summary",

        sections: List[str] | None = None,

    ) -> str | None:

        cfg = self.get_skill(agent, name)

        if not cfg:

            return None

        if mode == "summary":

            text = (cfg.summary or cfg.description or "").strip()

            if text:

                return text

            tmpl = (cfg.template or "").strip()

            max_len = 200

            if len(tmpl) > max_len:

                tmpl = tmpl[: max_len - 3] + "..."

            return tmpl or None

        target_sections = sections or cfg.default_full_sections or list(cfg.doc_sections.keys())

        return self._render(cfg, context, sections=target_sections or None)



    def _render(self, cfg: SkillConfig, context: Dict[str, Any], sections: List[str] | None = None) -> str:

        ctx = dict(context or {})

        if cfg.schema_example is not None:

            schema_str = json.dumps(cfg.schema_example, ensure_ascii=False, indent=2)

            # 对示例 JSON 做长度限制，避免长 schema 在模板中占用过多 token

            max_schema_chars = 800

            if len(schema_str) > max_schema_chars:

                schema_str = schema_str[: max_schema_chars - 3] + "..."

            ctx.setdefault("schema_example", schema_str)

        if cfg.output_schema is not None:

            output_schema_str = json.dumps(cfg.output_schema, ensure_ascii=False, indent=2)

            max_schema_chars = 800

            if len(output_schema_str) > max_schema_chars:

                output_schema_str = output_schema_str[: max_schema_chars - 3] + "..."

            ctx.setdefault("output_schema", output_schema_str)

        if cfg.extra_notes is not None:

            ctx.setdefault("extra_notes", cfg.extra_notes)

        if sections:

            doc_texts = self._load_doc_sections(cfg.doc_sections, sections)

            for key, text in doc_texts.items():

                ctx.setdefault(f"doc_{key}", text)

        safe_ctx = _SafeDict(ctx)

        try:

            return cfg.template.format_map(safe_ctx).strip()

        except Exception as exc:

            logger.warning("skill.render_failed name=%s error=%s", cfg.name, exc)

            return ""



    def _load_doc_sections(self, doc_map: Dict[str, str], sections: List[str]) -> Dict[str, str]:

        if not doc_map or not sections:

            return {}

        docs_root = self._docs_root if self._docs_root.exists() else self.base_dir

        results: Dict[str, str] = {}

        for key in sections:

            rel_path = doc_map.get(key)

            if not rel_path:

                continue

            doc_path = (docs_root / rel_path).resolve()

            try:

                doc_path.relative_to(docs_root)

            except ValueError:

                logger.warning("skill.doc_path_out_of_root section=%s path=%s", key, doc_path)

                continue

            if not doc_path.is_file():

                logger.warning("skill.doc_not_found section=%s path=%s", key, doc_path)

                continue

            text = self._doc_cache.get(doc_path)

            if text is None:

                try:

                    text = doc_path.read_text(encoding="utf-8").strip()

                except Exception as exc:

                    logger.warning("skill.doc_read_failed section=%s path=%s error=%s", key, doc_path, exc)

                    continue

                self._doc_cache[doc_path] = text

            results[key] = text

        return results



    def run_inference(

        self,

        *,

        agent: str,

        name: str,

        context: Dict[str, Any],

        conversation_snippet: str,

        client_factory,

    ) -> tuple[dict, int | None]:

        cfg = self.get_skill(agent, name)

        if not cfg:

            return {}, None

        if cfg.kind != "inference":

            logger.warning("skill.inference_wrong_kind name=%s kind=%s", cfg.name, cfg.kind)

            return {}, None

        template = self._render(

            cfg,

            {

                **context,

                "recent_dialogue": conversation_snippet,

            },

            sections=cfg.default_full_sections or list(cfg.doc_sections.keys()),

        )

        if not template:

            return {}, None

        # 限制推理型技能模板的最大长度，避免包含大段 schema/example 时无谓消耗大量 token

        max_template_chars = 3000

        if len(template) > max_template_chars:

            logger.info(

                "skill.template_truncated agent=%s name=%s orig_len=%s limit=%s",

                agent,

                name,

                len(template),

                max_template_chars,

            )

            template = template[:max_template_chars]

        messages = [{"role": "system", "content": template}]

        client = client_factory()

        try:

            reply, usage = client.chat(messages)

        except Exception as exc:

            logger.exception("skill.intent_call_failed name=%s error=%s", cfg.name, exc)

            return {}, None

        try:

            data = json.loads(reply)

        except Exception:

            logger.warning("skill.intent_parse_failed name=%s raw=%s", cfg.name, reply[:400])

            return {}, usage

        if not isinstance(data, dict):

            return {}, usage

        return data, usage





class _SafeDict(dict):

    def __missing__(self, key: str) -> str:

        return ""

