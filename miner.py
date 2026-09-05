#!/usr/bin/env python3
"""Thin wrapper so `python miner.py discover` matches the spec."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CMD = [
    "pnpm",
    "tsx",
    "--conditions=react-server",
    "packages/data/src/scripts/opportunity-miner.mts",
    *sys.argv[1:],
]
sys.exit(subprocess.call(CMD, cwd=ROOT))
