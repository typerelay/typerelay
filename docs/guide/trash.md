---
title: "TypeRelay Trash"
description: "Restore or permanently delete TypeRelay libraries and snippets from 30-day Trash while respecting permissions, conflicts, and purge rules."
---

# Trash

Moving a snippet or library to Trash removes it from normal browsing, search and expansion immediately. It can be restored for 30 days; after the deadline, cleanup permanently removes its content.

Open **Trash** from the web avatar menu or press F7 in the TUI. Restore validates permissions, limits and active abbreviation uniqueness. If a restored abbreviation would collide with another active snippet, resolve the collision first; TypeRelay never replaces the active record.

Trashing a library groups its currently active snippets under the library’s restore deadline. Snippets that were already trashed keep their own deadlines. Restoring the library therefore does not restore independently trashed snippets.

Editors may trash and restore snippets in editable libraries. Only a library creator or account owner/admin may trash, restore or permanently purge the shared library itself. Permanent snippet purge also requires manage permission; it cannot be undone.

**Empty Trash** permanently removes only the explicit eligible items shown at confirmation time and rechecks their revisions. Expired or purged content cannot be recovered. Offline devices receive content-free purge records on their next successful sync so old queued changes cannot recreate removed content.
