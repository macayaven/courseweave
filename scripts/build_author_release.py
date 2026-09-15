#!/usr/bin/env python3
"""Build a separate Author directory and archive from an exact local input receipt."""
import argparse
import json
from pathlib import Path
from courseweave.author_bundle import build_bundle, pack_bundle


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--archive', required=True, type=Path)
    args = parser.parse_args()
    receipt = json.loads(args.receipt.read_text())
    inputs = {key: (args.receipt.parent / item['path'], item['sha256']) for key, item in receipt['files'].items()}
    build_bundle(inputs, args.output, platform_commit=receipt['platform_commit'])
    print(json.dumps(pack_bundle(args.output, args.archive), indent=2))
