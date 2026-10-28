import subprocess

print("PR_CHECKER_EXECUTED")
print("CHECKER_HEAD=" + subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip())
