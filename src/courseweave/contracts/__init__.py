"""Canonical v2 contracts. Normal runtime cutover is deliberately separate."""
from .models import CourseManifest


def manifest_schema() -> dict:
    """Generate structural JSON Schema; model/root validation adds semantics."""
    return {'$schema': 'https://json-schema.org/draft/2020-12/schema', **CourseManifest.model_json_schema()}


__all__ = ['CourseManifest', 'manifest_schema']
