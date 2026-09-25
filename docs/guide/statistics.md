---
title: "TypeRelay usage statistics"
description: "Track personal and team snippet usage in TypeRelay, estimate time and money saved, and export reports with privacy-aware statistics."
---

# Statistics

Open the chart button beside **New library** in the web app. Desktop settings, browser extension settings, and mobile settings link to the same report.

Personal statistics cover your own usage of synchronized libraries. Owners and admins with team access can select **Team** for shared-library totals and member breakdowns. Private libraries never contribute to team reports. Local-only libraries remain on the device and do not contribute to web reports.

## What counts

A successful abbreviation expansion, picker/keyboard insertion, or explicit snippet copy counts as one use. Copies and insertions appear separately. Previews, searches, cancellations, rejected insertions, and internal clipboard preparation do not count. Operating systems do not always confirm that another application accepted text; TypeRelay records completion of the platform insertion operation.

Statistics begin with updated clients. Previous usage cannot be reconstructed. Devices queue counts offline and upload after reconnecting. Mobile keyboard usage uploads when the containing TypeRelay app next runs and synchronizes. Copies cannot confirm that content was subsequently pasted.

## Savings estimates

Defaults are **50 words per minute**, **USD ($)**, and **$30 per hour**. The hourly rate is an editable starting value, not an average-wage claim. Personal and team settings are independent; admins configure team settings.

- Characters saved = rendered plain-text characters minus the abbreviation/prefix characters replaced, with a minimum of zero.
- Explicit copies and picker insertions subtract no abbreviation.
- Estimated minutes saved = characters saved / (5 × words per minute).
- Estimated money saved = minutes saved / 60 × hourly rate.

Images, HTML markup, and Enter key actions add no character savings. Image-only actions count as uses with zero text savings. All character counts use Unicode scalar values consistently across clients. Fill-in answers contribute to rendered character counts but their contents are never sent as usage data.

Changing estimate settings recalculates existing reports. Changing currency selects the denomination; it does not convert exchange rates. A rate of zero shows zero monetary savings.

## Reports and export

The default period is the last 30 calendar days. Choose 7 days, 90 days, all time, or a custom inclusive date range. Daily boundaries use your browser's timezone, displayed on the report.

Review daily activity and sortable snippet/library tables. Team reports include members. CSV export uses the same selected scope, dates, timezone, and estimate settings. Open reports refresh counts every 30 seconds without reloading the page.

Historical totals remain after deleting snippets. Unavailable records use generic labels, and former members lose access while their shared usage remains in team totals. Making a shared library private removes it from team reports. Events uploaded after access is revoked are discarded. Account deletion removes its statistics and preferences.

Usage records contain IDs, action/client, timestamp, character counts, and shared eligibility. They do not contain snippet text, clipboard contents, fill-in answers, or target application details.
