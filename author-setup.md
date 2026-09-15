# Author Edition setup

Use the separate **CourseWeave Author Edition v0.3.0** candidate folder. Open
**Start Author.command** on macOS. The included README covers the complete
authoring, preview, distribution and recovery workflow. This is a local candidate;
its [acceptance status](docs/pilot/author-edition-acceptance.md) lists remaining gates.

Keep the folder and chosen Author home on nonsynced local storage. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/) if requested. First setup
installs Python 3.11, JupyterLab 4.6.3 and an isolated Python 3.12 notebook runtime.
No Node, source checkout or model key is needed to use the bundle.

```sh
./"Start Author.command" setup --home /local/path/to/new-author-home
./"Start Author.command" check --home /local/path/to/new-author-home
./"Start Author.command" --no-provider --home /local/path/to/new-author-home
```

Use that same home to resume saved projects. Its `workspace/projects` contains
private Author projects; `workspace/previews` contains separate Student practice.
The launcher refuses a folder with unrelated work. A changed application build
uses a new default home. Move work through explicit inspected backup/restore.
Keep the terminal open while authoring and use Ctrl-C to stop the owned session.

The assistant and Brave discovery require separate explicit opt-in:

```sh
./"Start Author.command" --provider openai --model YOUR_MODEL --search-key
```

Keys are entered through hidden prompts for this launch. A protected environment
tool may instead supply selected provider variables with `--provider-env`, and
BRAVE_SEARCH_API_KEY with `--search-key-env`. Neither option reads a .env file.
Research remains an explicit bounded action; source approval and distribution
rights remain separate decisions. Existing Student homes are never setup inputs.

See [source research](docs/author/research.md), [reviewed reports](docs/author/reviews.md),
[course delivery](docs/author/delivery.md), [Student preview](docs/author/preview.md)
and [backup/recovery](docs/author/recovery.md). Source builds and exact input receipt
instructions are in [RELEASING](docs/RELEASING.md).
