from __future__ import annotations

from typing import Any


def compile_provider_schema(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema
    if not schema:
        return {"type": "string"}

    cleaned: dict[str, Any] = {}
    for key, value in schema.items():
        if key in {"default", "examples", "example", "title"}:
            continue
        if key in {"properties", "$defs", "definitions"} and isinstance(value, dict):
            props: dict[str, Any] = {}
            for sub_key, sub_schema in value.items():
                compiled = compile_provider_schema(sub_schema)
                if isinstance(compiled, dict) and compiled:
                    props[sub_key] = compiled
            cleaned[key] = props
            continue
        if key == "items":
            cleaned[key] = compile_provider_schema(value)
            continue
        if key in {"anyOf", "oneOf", "allOf"} and isinstance(value, list):
            variants = [compile_provider_schema(item) for item in value if item]
            if variants:
                cleaned[key] = variants
            continue
        if key == "additionalProperties":
            cleaned[key] = False if value is True else value
            continue
        cleaned[key] = value

    if "properties" in cleaned and "type" not in cleaned:
        cleaned["type"] = "object"
    if cleaned.get("type") == "array" and "items" not in cleaned:
        cleaned["items"] = {"type": "string"}
    if "required" in cleaned and not cleaned.get("required"):
        cleaned.pop("required", None)
    if not cleaned:
        return {"type": "string"}
    return cleaned


def validate_provider_schema(schema: Any, *, path: str = "$") -> list[str]:
    errors: list[str] = []
    if not isinstance(schema, dict):
        errors.append(f"{path}: schema must be an object")
        return errors

    schema_type = schema.get("type")
    if schema_type == "array" and "items" not in schema:
        errors.append(f"{path}: array schema missing items")
    if schema_type == "object":
        props = schema.get("properties")
        if props is not None and not isinstance(props, dict):
            errors.append(f"{path}.properties: must be an object")

    props = schema.get("properties")
    if isinstance(props, dict):
        for key, value in props.items():
            errors.extend(validate_provider_schema(value, path=f"{path}.properties.{key}"))

    if "items" in schema:
        errors.extend(validate_provider_schema(schema.get("items"), path=f"{path}.items"))

    for key in ("anyOf", "oneOf", "allOf"):
        variants = schema.get(key)
        if isinstance(variants, list):
            for idx, value in enumerate(variants):
                errors.extend(validate_provider_schema(value, path=f"{path}.{key}[{idx}]"))

    return errors
