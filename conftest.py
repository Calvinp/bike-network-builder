"""Ensure this tool's root is importable so `import bikenetwork` works under
pytest — both when run from this folder and from the repo root."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
