#!/usr/bin/env swift

// Run from an Accessibility-approved local terminal with TypeRelay running,
// examples/matches.yml imported and a blank untitled TextEdit document focused.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum Scenario: String, CaseIterable {
	case overlap
	case immediateFollow = "immediate-follow"
	case afterRelease = "after-release"
	case burst
	case releaseTimeout = "release-timeout"

	var expected: String { switch self { case .burst: "Be right back.xyz";case .releaseTimeout: ";brb xy";default: "Be right back.x" } }
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
	return value
}

private func post(_ key: CGKeyCode, down: Bool) {
	let source = CGEventSource(stateID: .hidSystemState)!
	let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)!
	if down, var character = [41: ";", 11: "b", 15: "r", 49: " ", 7: "x", 16: "y", 6: "z"][key]?.utf16.first {
		event.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
	}
	event.post(tap: .cghidEventTap)
	Thread.sleep(forTimeInterval: 0.008)
}

private func stroke(_ key: CGKeyCode) {
	post(key, down: true)
	post(key, down: false)
}

private func run(_ scenario: Scenario) {
	let trigger: [CGKeyCode] = [41, 11, 15, 11, 49]
	post(trigger[0], down: true)
	for index in 1..<trigger.count {
		post(trigger[index], down: true)
		post(trigger[index - 1], down: false)
	}
	switch scenario {
	case .immediateFollow:
		post(7, down: true)
		post(49, down: false)
		post(7, down: false)
	case .afterRelease:
		post(49, down: false)
		stroke(7)
	case .burst:
		post(49, down: false)
		for key: CGKeyCode in [7, 16, 6] { stroke(key) }
	case .releaseTimeout:
		stroke(7)
		Thread.sleep(forTimeInterval: 2.3)
		post(49, down: false)
		stroke(16)
	case .overlap:
		post(49, down: false)
		Thread.sleep(forTimeInterval: 0.7)
		stroke(7)
	}
}

guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
	fputs("Run from a terminal allowed under Privacy & Security → Accessibility.\n", stderr)
	exit(2)
}
guard let textEdit = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first else {
	fputs("Open a blank untitled TextEdit document first.\n", stderr)
	exit(2)
}
textEdit.activate(options: [.activateAllWindows])
Thread.sleep(forTimeInterval: 0.8)
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == textEdit.processIdentifier else {
	fputs("TextEdit did not become active.\n", stderr)
	exit(2)
}
let application = AXUIElementCreateApplication(textEdit.processIdentifier)
guard let window = attribute(application, kAXFocusedWindowAttribute) as! AXUIElement?, let title = attribute(window, kAXTitleAttribute) as? String, title.hasPrefix("Untitled"), let focused = attribute(application, kAXFocusedUIElementAttribute) as! AXUIElement?, let initial = attribute(focused, kAXValueAttribute) as? String, initial.isEmpty else {
	fputs("Focus a blank untitled TextEdit document; existing content is never cleared.\n", stderr)
	exit(2)
}
var passed = true
for (index, scenario) in Scenario.allCases.enumerated() {
	if index > 0, AXUIElementSetAttributeValue(focused, kAXValueAttribute as CFString, "" as CFString) != .success {
		fputs("Could not reset the test-owned TextEdit content.\n", stderr)
		exit(2)
	}
	run(scenario)
	Thread.sleep(forTimeInterval: 1.5)
	let actual = attribute(focused, kAXValueAttribute) as? String ?? ""
	let scenarioPassed = actual == scenario.expected
	print("\(scenarioPassed ? "PASS" : "FAIL"): \(scenario.rawValue): \(actual.debugDescription)")
	passed = passed && scenarioPassed
}
exit(passed ? 0 : 1)
