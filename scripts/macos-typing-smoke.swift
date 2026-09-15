#!/usr/bin/env swift

import AppKit
import CoreGraphics
import Foundation

private enum Scenario: String {
	case overlap
	case immediateFollow = "immediate-follow"

	var expected: String { "Be right back.x" }
}

private final class SmokeTest: NSObject, NSApplicationDelegate {
	private let scenario: Scenario
	private let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 640, height: 240))
	private var monitor: Any?
	private var window: NSWindow?

	init(scenario: Scenario) { self.scenario = scenario }

	func applicationDidFinishLaunching(_ notification: Notification) {
		monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { event in
			print("EVENT: \(event.type.rawValue) key=\(event.keyCode)")
			fflush(stdout)
			return event
		}
		window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
		guard let window else { exit(2) }
		window.title = "TypeRelay macOS typing smoke"
		window.contentView = textView
		window.makeKeyAndOrderFront(nil)
		window.makeFirstResponder(textView)
		window.orderFrontRegardless()
		NSRunningApplication.current.activate(options: [.activateAllWindows])
		NSApp.activate()
		DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
			let frontmost = NSWorkspace.shared.frontmostApplication
			print("TARGET: \(frontmost?.localizedName ?? "none") pid=\(frontmost?.processIdentifier ?? -1) self=\(ProcessInfo.processInfo.processIdentifier)")
			fflush(stdout)
			guard frontmost?.processIdentifier == ProcessInfo.processInfo.processIdentifier else { exit(3) }
			DispatchQueue.global().async { [self] in
				runScenario()
				DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in finish() }
			}
		}
	}

	private func post(_ key: CGKeyCode, down: Bool) {
		let source = CGEventSource(stateID: .hidSystemState)!
		let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)!
		event.post(tap: .cghidEventTap)
		Thread.sleep(forTimeInterval: 0.008)
	}

	private func stroke(_ key: CGKeyCode) {
		post(key, down: true)
		post(key, down: false)
	}

	private func runScenario() {
		let trigger: [CGKeyCode] = [41, 11, 15, 11, 49]
		post(trigger[0], down: true)
		for index in 1..<trigger.count {
			post(trigger[index], down: true)
			post(trigger[index - 1], down: false)
		}
		if scenario == .immediateFollow {
			post(7, down: true)
			post(49, down: false)
			post(7, down: false)
		} else {
			post(49, down: false)
			Thread.sleep(forTimeInterval: 0.7)
			stroke(7)
		}
	}

	private func finish() {
		let actual = textView.string
		let passed = actual == scenario.expected
		print("\(passed ? "PASS" : "FAIL"): \(scenario.rawValue): \(actual.debugDescription)")
		fflush(stdout)
		exit(passed ? 0 : 1)
	}
}

guard CGPreflightPostEventAccess() else {
	fputs("Run this smoke test from a terminal allowed under Privacy & Security → Accessibility.\n", stderr)
	exit(2)
}
guard let scenario = CommandLine.arguments.dropFirst().first.flatMap(Scenario.init(rawValue:)) else {
	fputs("Usage: macos-typing-smoke.swift overlap|immediate-follow\n", stderr)
	exit(2)
}
private let app = NSApplication.shared
private let smoke = SmokeTest(scenario: scenario)
app.setActivationPolicy(.regular)
app.delegate = smoke
app.run()
