"""Small inspectable record validator; execution remains a learner action."""
from jsonschema import Draft202012Validator
SCHEMA = {"type": "object", "required": ["name", "age"], "properties": {"name": {"type": "string"}, "age": {"type": "integer", "minimum": 0}}}
def accepts(record):
    return Draft202012Validator(SCHEMA).is_valid(record)
if __name__ == "__main__":
    import json
    from pathlib import Path
    Path("terminal-result.json").write_text(json.dumps({"accepted": accepts({"name": "Ada", "age": 37})}) + "\n")
    print("Saved terminal-result.json")
