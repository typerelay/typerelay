// Pure snapshot merge for the extension's local item list. The server returns
// changed libraries since a cursor, plus the complete accessible set, purged
// libraries, and tombstones. Existing items are mutated only where the server
// reports a change so a full snapshot is not required on every sync.
export function resolveCursor(stored = {}) {
	const items = Array.isArray(stored.items) ? stored.items : null;
	const cursor = Number.isSafeInteger(stored.cursor) && stored.cursor > 0 ? stored.cursor : 0;
	return items === null ? 0 : cursor;
}

export function mergeItems(existing, snapshot) {
	const accessible = Array.isArray(snapshot.accessible) ? new Set(snapshot.accessible) : null;
	const purged = new Set(snapshot.purged || []);
	const tombstoned = new Set((snapshot.tombstones || []).map(row => row.id));
	const departed = new Set((snapshot.departures || []).map(row => String(row.library) + ':' + row.id));
	const overrides = new Map((snapshot.personal_abbreviations || []).map(row => [row.snippet, row.trigger]));
	const itemFor = (library, snippet) => ({ id: snippet.id, trigger: library.shared ? (overrides.get(snippet.id) ?? snippet.trigger) : snippet.trigger, title: snippet.title, library: library.name, library_id: library._id, shared: library.shared === true, content: snippet.content });
	const byLibrary = new Map();
	for (const item of existing) {
		if (!byLibrary.has(item.library_id)) byLibrary.set(item.library_id, []);
		byLibrary.get(item.library_id).push(item);
	}
	for (const library of snapshot.libraries || []) {
		const items = library.state === 'active' ? library.snippets.filter(snippet => snippet.state === 'active').map(snippet => itemFor(library, snippet)) : [];
		byLibrary.set(String(library._id), items);
	}
	const items = [];
	for (const [libraryId, entries] of byLibrary) {
		if (purged.has(libraryId)) continue;
		for (const item of entries) {
			if (tombstoned.has(item.id)) continue;
			if (departed.has(String(item.library_id) + ':' + item.id)) continue;
			if (accessible && !accessible.has(libraryId)) continue;
			items.push(item);
		}
	}
	const counts = new Map();
	for (const item of items) if (item.trigger) counts.set(item.trigger, (counts.get(item.trigger) || 0) + 1);
	for (const item of items) item.abbreviation_collision = (counts.get(item.trigger) || 0) > 1;
	return items;
}