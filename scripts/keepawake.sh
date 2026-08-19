#!/bin/sh
# keepawake.sh — explain (and where safe, show) how to keep the doushabao
# Mac awake. Non-destructive: this script never changes system power
# settings itself (that needs sudo + your explicit say-so). It only prints
# the current state and the exact commands to run.
#
# Product requirement: the daemon can only see DingTalk events while the Mac
# is awake and connected — no offline replay exists (ARCHITECTURE.md). The
# signed-off approach is "lid open on power" (or clamshell + external
# display/power), plus sleep prevention.
set -eu

echo "==> Current power settings (pmset -g; read-only, no sudo needed):"
pmset -g || true
echo

echo "==> Hint: to stop the Mac sleeping while on AC power, run (needs sudo):"
echo "        sudo pmset -c sleep 0"
echo "    This disables idle system sleep only while connected to AC power."
echo "    It does NOT stop display sleep or override a closed lid — for that,"
echo "    the Mac must stay lid-open on power, or run in clamshell mode with"
echo "    an external display + keyboard/mouse attached (per the signed-off design)."
echo

echo "==> Alternative / supplement: caffeinate"
echo "    'caffeinate -ims' prevents idle, display, and system sleep for as"
echo "    long as it keeps running. It needs no sudo. Run it long-lived"
echo "    alongside the daemon, e.g.:"
echo "        nohup caffeinate -ims >/dev/null 2>&1 &"
echo "    disown"
echo "    Kill it with: pkill -f 'caffeinate -ims'"
echo "    Unlike 'sudo pmset -c sleep 0', this only holds sleep off while the"
echo "    caffeinate process itself is alive — safer to leave running than a"
echo "    permanent pmset change, but it stops working if the Mac reboots."
