"""Explicit migration only. The active runtime must never call this converter."""
from .convert import convert_legacy, preview_legacy, MigrationResult, MigrationIssue, SemanticMapping

__all__ = ['convert_legacy', 'preview_legacy', 'MigrationResult', 'MigrationIssue', 'SemanticMapping']
