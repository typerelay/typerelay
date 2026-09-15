#!/opt/homebrew/bin/fish

cd (dirname (status filename))/..
set result /tmp/typerelay-macos-typing-smoke.log
true >$result
swift scripts/macos-typing-smoke.swift overlap >>$result 2>&1
set overlap_status $status
swift scripts/macos-typing-smoke.swift immediate-follow >>$result 2>&1
set follow_status $status
if test $overlap_status -eq 0 -a $follow_status -eq 0
	exit 0
end
exit 1
