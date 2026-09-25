---
title: "TypeRelay operating system notes"
description: "Review TypeRelay Desktop behavior, permissions, safety limits, and compatibility notes for Omarchy, macOS, and Windows."
---

# Operating system notes

TypeRelay verifies the original window before insertion. If focus cannot be restored safely, it reports an error and leaves the result available for Copy rather than typing into another application. Native focus APIs still have unavoidable races, so test your critical applications before a broad rollout.

## Omarchy/Hyprland

- Continuous expansion is verified with Omarchy/Hyprland, keyd’s effective virtual keyboard, uinput and a US keyboard layout.
- The installer configures only the required keyboard, pointer-cancellation and uinput access. The engine runs as a systemd user service, never as root.
- A pointer click, focus change or lock screen cancels a pending abbreviation. Keyboard reconnects are handled by the managed service restart path.
- Running Espanso at the same time is unsafe. TypeRelay detects its virtual device, sends a notification and stops instead of repeatedly restarting. Stop Espanso, then explicitly restart TypeRelay.
- AutoKey, xremap, kmonad and other input injectors are reported during installation but cannot all be detected at runtime. keyd and Fcitx are expected components.
- Closing or quitting the panel does not stop the separate expansion service. Use `systemctl --user stop typerelay` to stop continuous expansion.
- The TUI suppresses expansion only in its own registered live terminal window.
- The generic Linux GUI packages do not install the input service. Other compositors and non-US layouts are not supported targets.

## macOS

- macOS requires **System Settings → Privacy & Security → Accessibility** for focus restoration/insertion and **Input Monitoring** for abbreviation detection. The panel’s Settings shows each permission separately and opens the matching pane.
- Continuous expansion listens at the physical HID event tap. Apple Screen Sharing and some VNC tools synthesize input above that tap, so panel insertion can work while typed abbreviations are not detected. Test locally or through a hardware KVM.
- The current public package target is Apple Silicon. Universal builds are a release option only when both architectures are present and verified.
- TypeRelay uses the clipboard briefly for insertion and restores it only while it still owns the temporary value. A clipboard state it cannot preserve causes insertion to stop; use Copy.
- The bundled TUI opens in Terminal from Settings and shares the same database.
- Replacing the app with an ad-hoc or differently signed build may reset Accessibility or Input Monitoring approval.

## Windows

- The current installer target is x64. Continuous expansion uses the active application’s keyboard layout and accounts for Shift, Caps Lock and AltGr.
- A normally running TypeRelay process cannot inject into elevated or protected applications. Run the target at the same integrity level; TypeRelay does not elevate itself to bypass Windows security.
- Remote Desktop clipboard providers can refuse clipboard snapshots. In that case insertion may succeed but leave the inserted text on the clipboard instead of restoring the previous clipboard. Use Copy when clipboard preservation matters.
- Expansion is paused while the TypeRelay TUI window is active. Open the TUI from the Start menu.
- Windows may refuse to restore focus to a window. TypeRelay then reports the failure and offers Copy; it does not redirect insertion to the current foreground application.

## All platforms

- Release shortcut keys before insertion. TypeRelay waits briefly and cancels instead of inserting with stuck modifiers.
- Clipboard restoration never overwrites content copied by another application while insertion is finishing.
- Templates with explicit Enter actions can submit forms or run terminal commands. Review the preview before inserting.
- Search and expansion work offline. Sign-in, synchronization, team changes and update checks require network access.
