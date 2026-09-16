# Author Edition setup

Download the Author bundle and `SHA256SUMS` from the
[v0.3.0 release page](https://github.com/macayaven/courseweave/releases/tag/v0.3.0).
The release page records whether public-download verification is complete.
The included README covers authoring, preview, distribution and recovery; the
[acceptance record](docs/pilot/author-edition-acceptance.md) states tested limits.

From a nonsynced local download folder:

```sh
curl -fLO https://github.com/macayaven/courseweave/releases/download/v0.3.0/courseweave-author-0.3.0-macos.tar.gz
curl -fLO https://github.com/macayaven/courseweave/releases/download/v0.3.0/SHA256SUMS
shasum -a 256 --check SHA256SUMS --ignore-missing | grep -F 'courseweave-author-0.3.0-macos.tar.gz: OK'
tar -xzf courseweave-author-0.3.0-macos.tar.gz
cd "CourseWeave Author Edition v0.3.0"
./"Start Author.command" --no-provider
```

Continue only when the checksum command prints the named bundle followed by `OK`.
You can also open **Start Author.command** in the extracted folder on macOS.

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
