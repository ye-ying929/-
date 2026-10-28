from pathlib import Path

marker = Path("marker.txt").read_text(encoding="utf-8").strip()
if marker != "base":
    raise SystemExit(f"unexpected marker: {marker}")
print("BASE_CHECKER_EXECUTED")
