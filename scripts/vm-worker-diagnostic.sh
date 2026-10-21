#!/usr/bin/env bash
# Read-only diagnostic of the VM worker service: systemd journal, unit
# properties, kernel OOM evidence and host memory. Nothing is modified.
set -u

unit="${1:-ai-agent-vm-worker}"
since="${2:-8 hours ago}"

echo "### host identity"
hostname
date -u '+%Y-%m-%dT%H:%M:%SZ'
echo

echo "### unit presence"
systemctl list-units --all --no-pager --plain 2>/dev/null | grep -iE 'ai-agent|vm-worker|runner' || true
echo

echo "### unit properties"
systemctl show "$unit" \
  -p Id -p ActiveState -p SubState -p Result -p ExecMainStatus -p ExecMainCode \
  -p NRestarts -p Restart -p RestartUSec -p MemoryCurrent -p MemoryPeak -p MemoryMax \
  -p TasksCurrent -p TasksMax -p CPUUsageNSec -p ActiveEnterTimestamp -p ExecMainStartTimestamp \
  -p ExecMainExitTimestamp -p FragmentPath -p DropInPaths 2>&1 || true
echo

echo "### unit definition (memory/cpu limits)"
systemctl cat "$unit" 2>&1 || true
echo

echo "### memory"
free -m 2>&1 || true
head -5 /proc/meminfo 2>&1 || true
echo

echo "### kernel oom evidence"
(journalctl -k --since "$since" --no-pager -o short-iso 2>/dev/null || dmesg -T 2>/dev/null) \
  | grep -iE 'out of memory|oom|killed process|memory cgroup' || echo '(no kernel oom lines)'
echo

echo "### worker journal tail"
journalctl -u "$unit" --since "$since" --no-pager -o short-iso 2>&1 | tail -400 || true
echo

echo "### worker restart marker count"
journalctl -u "$unit" --since "$since" --no-pager -o short-iso 2>/dev/null \
  | grep -c 'vm_worker_runner_recovered' || echo 0
echo

echo "### systemd unit lifecycle lines"
journalctl -u "$unit" --since "$since" --no-pager -o short-iso 2>/dev/null \
  | grep -iE 'Started |Stopped |Main process|Failed with result|Scheduled restart|code=|status=|Consumed ' \
  | tail -150 || true
