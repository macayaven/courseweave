#!/usr/bin/env python3
"""Build a generic Student bundle from a verified local artifact receipt."""
import argparse
from pathlib import Path
from courseweave.student_bundle import build

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.receipt, args.output)
    print(f'Student bundle: {args.output}\nStart: {args.output / "Start Course.command"}')
