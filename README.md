# CourseWeave

## Installed Agent Harness Path quickstart

From this checkout, build and install the wheel with JupyterLab 4.6.3, then
launch an Agent Harness Path adapter checkout:

```sh
uv build --wheel --out-dir dist
python3.11 -m venv /tmp/courseweave-v0
uv pip install --python /tmp/courseweave-v0/bin/python dist/courseweave-0.1.0-py3-none-any.whl 'jupyterlab==4.6.3'
PATH="/tmp/courseweave-v0/bin:$PATH" /path/to/agent-harness-path-adaptive-tutor/scripts/courseweave
```

The exact v0 release proof, versions, hashes, and test matrix are recorded in
[`docs/verification/v0.md`](docs/verification/v0.md).
