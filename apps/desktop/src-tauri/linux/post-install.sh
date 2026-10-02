#!/bin/sh
set -eu
# Package-manager lifecycle hook; no per-user installer or terminal setup.
modprobe uinput
udevadm control --reload-rules
udevadm trigger --subsystem-match=input
udevadm trigger --subsystem-match=misc
