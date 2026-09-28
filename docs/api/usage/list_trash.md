## Find recoverable removed content

Use the Trash listing to show removed libraries or snippets that remain accessible to the connected user. Ordinary removal takes content out of active search and expansion while retaining a recovery window. This endpoint reads that collection; it does not restore or permanently remove anything.

Each entry includes a target identity and revision, with a name, expiry information and capability flags such as `can_restore` and `can_purge`. Use those flags to decide which choices to present. A record appearing in Trash is not permission to purge it automatically.

## Keep recovery deliberate

Follow `next_cursor` to retrieve additional pages when needed. For a later restore or purge, preserve the target's type, ID, library and revision so the requested action identifies the selected record precisely. Content can change or expire between listing and action, so handle an unavailable target explicitly.

Restoring a snippet can require attention to abbreviation conflicts or plan limits. See the [Trash guide](/guide/trash) for the user-facing recovery rules and [errors and limits](/api/errors) for failed requests. Permanent purge is a separate operation requiring its own scope and an explicit selection. Integrations should explain that distinction clearly instead of presenting both actions as interchangeable ways to clear the list.
