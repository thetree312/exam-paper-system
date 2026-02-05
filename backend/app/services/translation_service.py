import json
import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, List, Optional

import requests
from pydantic import BaseModel, Field, ValidationError, validator

from ..config import get_settings
from ..schemas import TranslationScope


logger = logging.getLogger("translation")


class TranslationServiceError(RuntimeError):
    pass


class TranslationModelError(TranslationServiceError):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class TranslationResult:
    translation: Optional[str] = None
    phonetic: Optional[str] = None
    word_translation: Optional[str] = None
    example: Optional[str] = None
    lemma: Optional[str] = None
    morphology: Optional[str] = None
    forms: Optional[List[str]] = None
    senses: Optional[List[dict]] = None


class WordSenseModel(BaseModel):
    pos: Optional[str] = None
    meaning: Optional[str] = None
    note: Optional[str] = None


class WordPayloadModel(BaseModel):
    phonetic: Optional[str] = None
    trans: Optional[str] = None
    example: Optional[str] = None
    lemma: Optional[str] = None
    morphology: Optional[str] = None
    forms: Optional[List[str]] = None
    senses: List[WordSenseModel] = Field(default_factory=list)

    @validator("forms", pre=True)
    def _coerce_forms(cls, value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        if isinstance(value, str):
            parts = [part.strip() for part in re.split(r"[;,/]|、|\s+", value) if part.strip()]
            return parts or None
        if isinstance(value, list):
            cleaned = [str(item).strip() for item in value if str(item).strip()]
            return cleaned or None
        return None

    @validator("senses", pre=True, always=True)
    def _coerce_senses(cls, value: Any) -> List[Any]:
        if not value:
            return []
        if isinstance(value, list):
            return value
        return [value]

    class Config:
        arbitrary_types_allowed = True
        extra = "ignore"


POS_TOKEN_PATTERN = re.compile(
    r"(?:ad[cvj]|n|vi|vt|v|prep|conj|pron|num|art|interj|aux)\.?",
    re.IGNORECASE,
)

POS_ALIASES: dict[str, str] = {
    "n": "n",
    "noun": "n",
    "v": "v",
    "verb": "v",
    "vi": "vi",
    "vt": "vt",
    "adv": "adv",
    "adverb": "adv",
    "adj": "adj",
    "adjective": "adj",
    "prep": "prep",
    "preposition": "prep",
    "conj": "conj",
    "conjunction": "conj",
    "pron": "pron",
    "pronoun": "pron",
    "num": "num",
    "number": "num",
    "art": "art",
    "article": "art",
    "interj": "interj",
    "interjection": "interj",
    "aux": "aux",
    "auxiliary": "aux",
}

CJK_PATTERN = re.compile(r"[\u4e00-\u9fff]")


class TranslationService:
    SENTENCE_MODEL_PRIORITIES: tuple[str, ...] = (
        "tencent/Hunyuan-MT-7B",
        "Qwen/Qwen2.5-7B-Instruct",
        "Qwen/Qwen2-7B-Instruct",
        "THUDM/glm-4-9b-chat",
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "THUDM/GLM-Z1-9B-0414",
    )
    WORD_MODEL_PRIORITIES: tuple[str, ...] = (
        "Qwen/Qwen2.5-7B-Instruct",
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "tencent/Hunyuan-MT-7B",
        "Qwen/Qwen2-7B-Instruct",
        "THUDM/glm-4-9b-chat",
        "THUDM/GLM-Z1-9B-0414",
    )

    def __init__(self) -> None:
        settings = get_settings()
        self.base_url = settings.siliconflow_base_url.rstrip("/")
        self.api_key = settings.siliconflow_api_key
        if not self.api_key:
            raise RuntimeError("SILICONFLOW_API_KEY 未配置，无法启用翻译功能")
        self._session = requests.Session()

    def translate(self, text: str, scope: TranslationScope) -> TranslationResult:
        model_priorities = (
            self.WORD_MODEL_PRIORITIES
            if scope == TranslationScope.word
            else self.SENTENCE_MODEL_PRIORITIES
        )
        last_error: Optional[TranslationModelError] = None
        for model in model_priorities:
            try:
                return self._call_model(model, text, scope)
            except TranslationModelError as exc:  # noqa: PERF203
                last_error = exc
                logger.warning(
                    "translation model failed model=%s retryable=%s err=%s",
                    model,
                    exc.retryable,
                    exc,
                )
                if not exc.retryable:
                    break
        raise last_error or TranslationServiceError("所有翻译模型均不可用")

    def _call_model(self, model: str, text: str, scope: TranslationScope) -> TranslationResult:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        system_prompt, user_prompt = self._build_prompts(text, scope)
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.2,
            "top_p": 0.85,
        }
        if scope == TranslationScope.word:
            payload["response_format"] = {"type": "json_object"}
        try:
            resp = self._session.post(url, headers=headers, json=payload, timeout=45)
        except requests.RequestException as exc:  # pragma: no cover - network failure
            raise TranslationModelError(str(exc), retryable=True) from exc

        if resp.status_code == 401:
            raise TranslationModelError("硅基流动 API 鉴权失败", retryable=False)
        if resp.status_code in {429, 500, 502, 503, 504}:
            raise TranslationModelError(
                f"model={model} status={resp.status_code}", retryable=True
            )
        if resp.status_code >= 400:
            raise TranslationModelError(resp.text or "翻译接口错误", retryable=False)

        data = resp.json()
        try:
            content = (
                data["choices"][0]["message"]["content"].strip()
            )
        except (KeyError, IndexError, AttributeError) as exc:
            raise TranslationModelError("翻译接口返回格式异常", retryable=False) from exc

        if scope == TranslationScope.word:
            parsed_model = self._parse_word_payload(content, model)
            lemma = self._safe_str(parsed_model.lemma)
            requested_token = self._normalize_token(text)
            lemma_token = self._normalize_token(lemma)
            forms = parsed_model.forms or self._extract_forms(parsed_model.morphology)
            morphology = self._safe_str(parsed_model.morphology)
            forms = self._deduplicate_forms(forms, morphology, lemma_token)
            if not morphology and forms:
                morphology = " / ".join(forms)
                forms = []
            self._validate_word_alignment(text, lemma, forms, morphology)
            word_translation = self._safe_str(parsed_model.trans)
            example = self._safe_str(parsed_model.example)
            example = self._ensure_example_mentions_word(text, lemma, example)
            senses = self._normalize_senses([sense.dict() for sense in parsed_model.senses])
            senses = self._ensure_chinese_senses(senses, word_translation, morphology)
            lemma_for_display = lemma
            if lemma_token and requested_token and lemma_token == requested_token:
                lemma_for_display = None
            return TranslationResult(
                translation=None,
                phonetic=self._safe_str(parsed_model.phonetic),
                word_translation=word_translation,
                example=example,
                lemma=lemma_for_display,
                morphology=morphology,
                forms=forms,
                senses=senses,
            )

        return TranslationResult(translation=content)

    @staticmethod
    def _safe_str(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def _validate_word_alignment(
        self,
        requested: str,
        lemma: Optional[str],
        forms: Optional[List[str]] = None,
        morphology: Optional[str] = None,
    ) -> None:
        requested_token = self._normalize_token(requested)
        lemma_token = self._normalize_token(lemma)
        if not requested_token or not lemma_token:
            return
        if requested_token == lemma_token:
            return
        if forms:
            for form in forms:
                form_token = self._normalize_token(form)
                if not form_token:
                    continue
                if requested_token == form_token:
                    return
                if self._token_similarity(requested_token, form_token) >= 0.72:
                    return
        if self._token_similarity(requested_token, lemma_token) >= 0.65:
            return
        if self._is_simple_inflection(requested_token, lemma_token):
            return
        if morphology and self._has_inflection_hint(morphology):
            return
        raise TranslationModelError(
            f"释义词条与请求不符: expected {requested_token}, got {lemma_token}",
            retryable=True,
        )

    @staticmethod
    def _token_similarity(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        return SequenceMatcher(None, a, b).ratio()

    @staticmethod
    def _is_simple_inflection(requested: str, lemma: str) -> bool:
        if not requested or not lemma:
            return False
        if requested.endswith("ies") and lemma.endswith("y"):
            return requested[:-3] == lemma[:-1]
        if requested.endswith("ied") and lemma.endswith("y"):
            return requested[:-3] == lemma[:-1]
        simple_endings = ("ing", "ed", "en", "s", "es")
        for ending in simple_endings:
            if requested.endswith(ending):
                base = requested[: -len(ending)]
                if base and base == lemma or base + ending[:1] == lemma:
                    return True
        return False

    @staticmethod
    def _has_inflection_hint(morphology: str) -> bool:
        lowered = morphology.lower()
        keywords = (
            "past",
            "participle",
            "present",
            "progressive",
            "gerund",
            "third",
            "comparative",
            "superlative",
            "plural",
            "irregular",
        )
        return any(keyword in lowered for keyword in keywords)

    @staticmethod
    def _normalize_token(value: Optional[str]) -> str:
        if not value:
            return ""
        text = str(value).strip()
        token = re.sub(r"[^a-zA-Z]", "", text).lower()
        return token

    def _parse_word_payload(self, content: str, model: str) -> WordPayloadModel:
        text = content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?", "", text, flags=re.IGNORECASE).strip()
            text = re.sub(r"```$", "", text).strip()
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            logger.error("word translation json parse failed model=%s content=%r", model, content)
            raise TranslationModelError("词汇释义解析失败", retryable=True) from exc
        try:
            return WordPayloadModel.parse_obj(parsed)
        except ValidationError as exc:
            logger.error(
                "word translation payload validation failed model=%s errors=%s content=%r",
                model,
                exc.errors(),
                content,
            )
            raise TranslationModelError("词汇释义字段缺失或格式错误", retryable=True) from exc

    def _extract_forms(self, value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        forms: List[str] = []
        if isinstance(value, str):
            parts = re.split(r"[;,/]|、|\s+", value)
            forms.extend(parts)
        elif isinstance(value, list):
            forms.extend(str(item) for item in value)
        else:
            return None
        normalized = [self._safe_str(form) for form in forms]
        return [form for form in normalized if form]

    def _deduplicate_forms(
        self,
        forms: Optional[List[str]],
        morphology: Optional[str],
        lemma_token: Optional[str],
    ) -> Optional[List[str]]:
        if not forms:
            return None
        morph_tokens: set[str] = set()
        if morphology:
            parts = re.split(r"[;/,\s]+", morphology)
            morph_tokens = {
                self._normalize_token(part)
                for part in parts
                if part and self._normalize_token(part)
            }
        deduped: list[str] = []
        seen: set[str] = set()
        for form in forms:
            token = self._normalize_token(form)
            if (
                not token
                or token in morph_tokens
                or token in seen
                or (lemma_token and token == lemma_token)
            ):
                continue
            deduped.append(form)
            seen.add(token)
        return deduped or None

    def _normalize_senses(self, senses: Optional[List[dict]]) -> Optional[List[dict]]:
        if not senses:
            return None
        normalized: List[dict] = []
        for sense in senses:
            if not isinstance(sense, dict):
                continue
            meaning = self._safe_str(sense.get("meaning"))
            if not meaning:
                continue
            normalized.append(
                {
                    "pos": self._normalize_pos(sense.get("pos")),
                    "meaning": meaning,
                    "note": self._safe_str(sense.get("note")),
                }
            )
        return normalized or None

    def _ensure_chinese_senses(
        self,
        senses: Optional[List[dict]],
        translation: Optional[str],
        morphology: Optional[str],
    ) -> Optional[List[dict]]:
        if senses and any(self._is_chinese(sense.get("meaning")) for sense in senses if sense):
            return senses
        fallback = self._build_fallback_senses(translation, morphology)
        return fallback or senses

    def _build_fallback_senses(
        self, translation: Optional[str], morphology: Optional[str]
    ) -> Optional[List[dict]]:
        if not translation:
            return None
        meanings = [
            segment.strip()
            for segment in re.split(r"[；;，、\n]", translation)
            if segment.strip()
        ]
        if not meanings:
            return None
        labels = self._parse_morphology_labels(morphology)
        fallback = []
        for index, meaning in enumerate(meanings):
            label = labels[index] if index < len(labels) else ""
            fallback.append({"pos": label, "meaning": meaning})
        return fallback or None

    def _parse_morphology_labels(self, morphology: Optional[str]) -> List[str]:
        if not morphology:
            return []
        tokens = POS_TOKEN_PATTERN.findall(morphology)
        if tokens:
            return [self._normalize_pos(token) for token in tokens]
        parts = [
            self._normalize_pos(part)
            for part in re.split(r"[/;,]|(?:\s{2,})", morphology)
            if part.strip()
        ]
        return [part for part in parts if part]

    def _ensure_example_mentions_word(
        self, word: str, lemma: Optional[str], example: Optional[str]
    ) -> Optional[str]:
        if not example:
            return None
        target = word.strip()
        targets = {target.lower()} if target else set()
        if lemma:
            targets.add(lemma.lower())
        example_lower = example.lower()
        if any(target and target in example_lower for target in targets):
            return example
        return None

    def _normalize_pos(self, value: Any) -> str:
        if value is None:
            return ""
        raw = (
            str(value)
            .replace("·", "")
            .replace("'", "")
            .replace("`", "")
            .strip()
            .lower()
        )
        raw = raw.rstrip(".")
        if not raw:
            return ""
        normalized = POS_ALIASES.get(raw, raw)
        return normalized or ""

    def _is_chinese(self, text: str | None) -> bool:
        if not text:
            return False
        return bool(CJK_PATTERN.search(text))

    def _build_prompts(self, text: str, scope: TranslationScope) -> tuple[str, str]:
        cleaned = text.strip()
        if scope == TranslationScope.word:
            system_prompt = (
                "你是一个严格的英汉词典助手。"
                "必须以 JSON 对象回应，并且只输出一行内容。"
                "禁止客套话、解释、Markdown 代码块、反引号或多余文本。"
                "如果无法满足要求，请输出一个包含 null 值的同结构 JSON。"
            )
            user_prompt = (
                "请解析下列英文单词，按严格 JSON Schema 输出：\n"
                "Schema => {\n"
                '  "type": "object",\n'
                '  "required": ["phonetic", "trans", "example", "lemma", "morphology", "senses"],\n'
                '  "properties": {\n'
                '    "phonetic": {"type": "string", "description": "英式音标，格式如 /.../"},\n'
                '    "trans": {"type": "string", "description": "核心中文释义，可包含多个含义"},\n'
                '    "example": {"type": "string", "description": "英文例句，必须包含目标词的原形或当前词形"},\n'
                '    "lemma": {"type": "string", "description": "词根/原形，如 be 的过去式为 was"},\n'
                '    "morphology": {"type": "string", "description": "形态或词形变化说明，例如 过去分词/复数"},\n'
                '    "senses": {\n'
                '      "type": "array",\n'
                '      "items": {"type": "object", "required": ["pos", "meaning"], "properties": {\n'
                '        "pos": {"type": "string", "description": "词性缩写，例如 n./vt./adj."},\n'
                '        "meaning": {"type": "string", "description": "对应中文释义"},\n'
                '        "note": {"type": "string", "description": "可选补充说明"}\n'
                "      }}\n"
                "    }\n"
                "  }\n"
                "}\n"
                "正例（仅此种格式被允许）：\n"
                '{"phonetic":"/spəʊkən/","trans":"口语的；说出的","example":"Spoken language evolves quickly.","lemma":"speak","morphology":"past participle / adjective","senses":[{"pos":"adj","meaning":"口语的"},{"pos":"adj","meaning":"说出的"}]}\n'
                "反例（包含解释性文字）——禁止：\n"
                '译文如下：{"phonetic":"/əbˈzɔːrb/","trans":"吸收","example":"..."}\n'
                "反例（含 Markdown 代码块）——禁止：\n"
                "```json\n"
                '{"phonetic":"/təʊn/","trans":"音调","example":"..."}\n'
                "```\n"
                "现在请根据以上规则，只输出 JSON：\n"
                f"{cleaned}"
            )
            return system_prompt, user_prompt

        system_prompt = (
            "你是一个精准的英译中翻译助手，只返回译文，禁止输出解释、前后缀。"
        )
        user_prompt = (
            "请将以下英文内容翻译成自然流畅的中文，仅输出译文原文，不要前缀：\n"
            f"{cleaned}"
        )
        return system_prompt, user_prompt
